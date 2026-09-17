/**
 * P43/P70：Agent 独立进程代理（main 侧）。
 *
 * - AgentProxy 与 AgentHost 接口同形：方法 → worker RPC；事件 → renderer。
 * - worker 异常退出后，不只重新 fork：会按最近已确认状态恢复 model runtime、会话文件、
 *   工作区、模型、思考等级、审批模式/允许清单和自动压缩开关。
 * - 崩溃瞬间的流式请求明确失败；恢复完成后由 renderer 提示用户重试本轮，不伪称无感续跑。
 */
import { utilityProcess } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createAgentProxy(win, userDataDir, onEvent = null) {
	let worker = null;
	let seq = 0;
	let dead = false;
	let generation = 0;
	let workspace = null;
	let spawning = null;
	let recovery = null;
	let disposed = false;
	/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void, method:string}>} */
	const pending = new Map();
	// 只缓存成功 RPC 的状态；敏感数据（prompt/image/API key）绝不进入恢复快照。
	const remembered = {
		initialized: false,
		session: null, // { sessionFile, workspace, provider, id, thinkingLevel }
		approvalMode: "auto-edit",
		approvalGoalText: null,
		approvalAllowlist: [],
		autoCompact: true,
	};

	const notifyRenderer = (event) => {
		try { onEvent?.(event); } catch { /* 钩子失败不影响事件流 */ }
		if (!win.isDestroyed()) {
			try { win.webContents.send("agent:event", event); } catch { /* 忽略 */ }
		}
	};

	function postRpc(method, args = []) {
		const s = ++seq;
		return new Promise((resolve, reject) => {
			pending.set(s, { resolve, reject, method });
			try {
				worker.postMessage({ seq: s, method, args: Array.isArray(args) ? args : [] });
			} catch (err) {
				pending.delete(s);
				reject(err);
			}
		});
	}

	function remember(method, args, result) {
		if (method === "init" || method === "refreshModels") remembered.initialized = true;
		if (method === "info" && result?.sessionFile) {
			remembered.initialized = true;
			remembered.session ??= {};
			remembered.session.sessionFile = result.sessionFile;
			remembered.session.workspace = result.workspace ?? workspace ?? null;
			remembered.session.provider = result.model?.provider ?? remembered.session.provider ?? null;
			remembered.session.id = result.model?.id ?? remembered.session.id ?? null;
			remembered.session.thinkingLevel = result.thinkingLevel ?? remembered.session.thinkingLevel ?? null;
			remembered.approvalMode = result.approvalMode ?? remembered.approvalMode;
			remembered.approvalAllowlist = Array.isArray(result.approvalAllowlist) ? result.approvalAllowlist : remembered.approvalAllowlist;
			remembered.autoCompact = result.autoCompact ?? remembered.autoCompact;
		}
		if (method === "start") {
			const opts = args?.[0] ?? {};
			remembered.initialized = true;
			remembered.session = {
				sessionFile: result?.sessionFile ?? opts.resumeFile ?? null,
				workspace: result?.workspace ?? opts.workspace ?? workspace ?? null,
				provider: result?.model?.provider ?? opts.provider ?? null,
				id: result?.model?.id ?? opts.id ?? null,
				thinkingLevel: opts.thinkingLevel ?? null,
			};
		}
		if (method === "setModel" && remembered.session) {
			remembered.session.provider = result?.provider ?? args?.[0] ?? null;
			remembered.session.id = result?.id ?? args?.[1] ?? null;
		}
		if (method === "setThinking" && remembered.session) remembered.session.thinkingLevel = result ?? args?.[0] ?? null;
		if (method === "setApprovalMode") {
			remembered.approvalMode = result ?? args?.[0] ?? "auto-edit";
			remembered.approvalGoalText = args?.[1] ?? null;
		}
		if (method === "setApprovalAllowlist") remembered.approvalAllowlist = Array.isArray(result) ? result : (Array.isArray(args?.[0]) ? args[0] : []);
		if (method === "setAutoCompact") remembered.autoCompact = result?.enabled ?? !!args?.[0];
	}

	async function restoreState() {
		if (remembered.initialized || remembered.session) await postRpc("init", []);
		if (remembered.session) {
			const s = remembered.session;
			const opts = s.sessionFile
				? { resumeFile: s.sessionFile, provider: s.provider, id: s.id, thinkingLevel: s.thinkingLevel }
				: { workspace: s.workspace, provider: s.provider, id: s.id, thinkingLevel: s.thinkingLevel };
			const info = await postRpc("start", [opts]);
			workspace = info?.workspace ?? s.workspace ?? null;
			s.sessionFile = info?.sessionFile ?? s.sessionFile;
			s.provider = info?.model?.provider ?? s.provider;
			s.id = info?.model?.id ?? s.id;
		}
		await postRpc("setApprovalMode", [remembered.approvalMode, remembered.approvalGoalText]);
		await postRpc("setApprovalAllowlist", [remembered.approvalAllowlist]);
		await postRpc("setAutoCompact", [remembered.autoCompact]);
	}

	function spawn({ recovering = false } = {}) {
		if (disposed) return Promise.reject(new Error("Agent 代理已释放"));
		if (spawning) return spawning;
		dead = false;
		const myGeneration = ++generation;
		let bootSeq = null;
		spawning = new Promise((resolve, reject) => {
			worker = utilityProcess.fork(path.join(__dirname, "agent-worker.mjs"), [], {
				serviceName: "openpi-agent",
				execArgv: [],
				stdio: "pipe",
			});
			worker.stderr?.on("data", (d) => process.stderr.write("[worker] " + d));
			worker.on("message", (msg) => {
				if (msg?.evt) {
					notifyRenderer(msg.event);
					return;
				}
				if (msg?.seq === bootSeq) {
					if (msg.ok) resolve();
					else reject(new Error(msg.error || "Agent worker 启动失败"));
					return;
				}
				const p = pending.get(msg?.seq);
				if (!p) return;
				pending.delete(msg.seq);
				if (msg.ok) {
					if (Object.prototype.hasOwnProperty.call(msg, "workspace")) workspace = msg.workspace;
					p.resolve(msg.result);
				} else p.reject(new Error(msg.error || "worker 调用失败"));
			});
			worker.on("exit", () => {
				if (myGeneration !== generation || disposed) return;
				if (spawning) reject(new Error("Agent worker 启动时退出"));
				dead = true;
				worker = null;
				spawning = null;
				for (const [, p] of pending) p.reject(new Error("Agent 进程异常退出；会话恢复后可重试本轮"));
				pending.clear();
				notifyRenderer({ type: "agent_recovering", interrupted: true });
				recovery = spawn({ recovering: true }).catch((err) => {
					notifyRenderer({ type: "agent_recovery_failed", error: String(err?.message ?? err).slice(0, 300) });
					throw err;
				});
				recovery.catch(() => {});
			});
			bootSeq = `boot-${myGeneration}`;
			worker.postMessage({ seq: bootSeq, method: "__boot", args: [userDataDir] });
		});
		return spawning.then(async () => {
			spawning = null;
			if (recovering) {
				await restoreState();
				dead = false;
				notifyRenderer({ type: "agent_recovered", interrupted: true });
			}
			return worker;
		}, (err) => {
			spawning = null;
			throw err;
		});
	}

	async function rpc(method, args) {
		if (recovery) {
			try { await recovery; } finally { recovery = null; }
		} else if (!worker || dead) await spawn({ recovering: dead });
		const result = await postRpc(method, args);
		remember(method, args, result);
		return result;
	}

	const proxy = new Proxy({}, {
		get(_t, prop) {
			if (prop === "workspace") return workspace;
			if (prop === "userDataDir") return userDataDir;
			if (prop === "win") return win;
			if (prop === "session") return { getAllTools: null };
			if (prop === "dispose") return () => {
				disposed = true;
				generation++;
				for (const [, p] of pending) p.reject(new Error("窗口已关闭"));
				pending.clear();
				try { worker?.kill(); } catch { /* 尽力 */ }
				worker = null;
			};
			return (...args) => rpc(String(prop), args);
		},
		set(_t, prop, value) {
			if (prop === "workspace") { workspace = value; return true; }
			return false;
		},
	});

	spawn();
	return proxy;
}
