/**
 * P43：Agent 独立进程代理（main 侧）。
 * AgentProxy 与 AgentHost 接口同形：方法 → worker RPC；workspace/userDataDir → 缓存属性；
 * 事件 → win.webContents.send("agent:event", e)。AgentHost 完整逻辑在子进程（agent-worker.mjs），
 * main 进程只剩 IPC 转发，不再背 pi SDK / 模型流 / auditLog 写盘。
 * 崩溃恢复：worker exit → 所有挂起请求失败 + 渲染层通知；下次方法调用自动重新 fork。
 */
import { utilityProcess } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createAgentProxy(win, userDataDir, onEvent = null) {
	let worker = null;
	let seq = 0;
	let dead = false;
	let workspace = null;
	/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
	const pending = new Map();

	const notifyRenderer = (event) => {
		try { onEvent?.(event); } catch { /* 钩子失败不影响事件流 */ }
		if (!win.isDestroyed()) {
			try { win.webContents.send("agent:event", event); } catch { /* 忽略 */ }
		}
	};

	function spawn() {
		dead = false;
		worker = utilityProcess.fork(path.join(__dirname, "agent-worker.mjs"), [], {
			serviceName: "openpi-agent",
			execArgv: [], // 继承默认；Electron utilityProcess 自带 Node 环境
			stdio: "pipe", // worker stderr 转发到主进程 stderr（排障日志通道）
		});
		worker.stderr?.on("data", (d) => process.stderr.write("[worker] " + d)); // 排障：转发 worker 打点
		worker.on("message", (msg) => {
			if (msg?.evt) {
				notifyRenderer(msg.event);
				return;
			}
			const p = pending.get(msg?.seq);
			if (!p) return;
			pending.delete(msg.seq);
			if (msg.ok) {
				if (typeof msg.workspace === "string" && msg.workspace) workspace = msg.workspace; // 同步缓存
				p.resolve(msg.result);
			} else {
				p.reject(new Error(msg.error || "worker 调用失败"));
			}
		});
		worker.on("exit", () => {
			dead = true;
			for (const [, p] of pending) p.reject(new Error("Agent 进程已退出"));
			pending.clear();
			notifyRenderer({ type: "ui_notify", message: "Agent 进程已重启，正在恢复会话上下文（如会话中断请重试）", level: "warning" });
		});
		worker.postMessage({ seq: "boot", method: "__boot", args: [userDataDir] }); // P43：注入 userDataDir
		return worker;
	}

	function rpc(method, args) {
		if (!worker || dead) spawn();
		const s = ++seq;
		return new Promise((resolve, reject) => {
			pending.set(s, { resolve, reject });
			try {
				worker.postMessage({ seq: s, method, args: Array.isArray(args) ? args : [] });
			} catch (err) {
				pending.delete(s);
				reject(err);
			}
		});
	}

	const proxy = new Proxy({}, {
		get(_t, prop) {
			if (prop === "workspace") return workspace; // main 直访属性（git/文件树/AGENTS.md 等 30 处）
			if (prop === "userDataDir") return userDataDir;
			if (prop === "win") return win;
			if (prop === "session") return { getAllTools: null }; // 禁用直访（main.mjs 已改走 toolNames()）
			if (prop === "dispose") return () => { try { worker?.kill(); } catch { /* 尽力 */ } };
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
