/**
 * AgentHost —— Pi SDK 的 Electron 主进程封装（M2）
 *
 * 职责：
 *  - 初始化 ModelRuntime（读取 ~/.pi/agent/{auth.json, models.json}）
 *  - 创建/重建 AgentSession；内联审批扩展拦截危险命令
 *  - 扩展 UI 桥接：confirm/select/input → 渲染层模态（ui_request/ui-response）
 *  - 会话树 / 手动压缩 / HTML 导出 / 会话改名
 *  - 把 Pi 事件原样转发给渲染进程（channel: "agent:event"）
 *
 * 原则：不修改 Pi 源码，只调用 @earendil-works/pi-coding-agent 公开 SDK。
 */
import { exec as hookExec } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
	createAgentSession,
	ModelRuntime,
	SessionManager,
	DefaultResourceLoader,
	getAgentDir,
	loadProjectContextFiles,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createSandbox, bindSession, cleanupExpired, sandboxRoot } from "./workspace-store.mjs";
import { webTools, setWebSettings } from "./web-tools.mjs"; // P47 联网检索（webfetch/websearch）
import { browserTools, BROWSER_WRITE } from "./browser-tools.mjs"; // P52 浏览器控制
import { gitTools, autoCheckpointIfNeeded, checkpointSystemPrompt, setGitWorkspace } from "./git-checkpoint.mjs"; // P53 git 检查点

/** P50：子代理工具（agent-as-tool）——独立上下文的只读研究员，结果摘要回主会话 */
function buildSubagentTool(host) {
	return {
		name: "subagent",
		label: "派发子任务",
		description:
			"派发一个独立上下文的子代理去完成子任务（如大范围探索代码、多篇资料调研、批量比对）。" +
			"子代理看不到主会话内容，prompt 必须自包含（背景 + 目标 + 期望产出）。" +
			"子代理只有只读工具（读文件/搜索/联网），不能写文件或执行命令。" +
			"返回子代理的最终结论文本。同一时间只能跑一个子任务。",
		promptSnippet: "- subagent: 派发独立子任务（探索/调研），结果摘要回主会话；prompt 必须自包含",
		parameters: Type.Object({
			prompt: Type.String({ description: "子任务完整描述（自包含，子代理看不到主会话）" }),
			task: Type.Optional(Type.String({ description: "一句话任务标题（用于展示）" })),
		}),
		async execute(_id, params, signal, onUpdate) {
			return host.runSubagent(params, signal, onUpdate);
		},
	};
}
/** 审批档位（跨窗口独立、跨会话保持）；plan = 计划模式（P35）；allow = 命令允许清单（P39：命中且非危险的命令免确认） */
const APPROVAL = { mode: "auto-edit", allow: [] };

/** P51：用户 Hooks —— ~/.pi/agent/hooks.json（工具调用前/后执行用户命令） */
function loadHooks() {
	try {
		const arr = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "hooks.json"), "utf8"));
		return Array.isArray(arr) ? arr.filter((h) => h && typeof h.command === "string" && ["before", "after"].includes(h.phase ?? "before")) : [];
	} catch {
		return []; // 无配置文件属正常
	}
}
function fillTemplate(cmd, input) {
	return cmd.replace(/\{\{\s*input\.([\w.]+)\s*\}\}/g, (_, k) => {
		let v = input;
		for (const part of k.split(".")) v = v?.[part];
		return v === undefined ? "" : String(v);
	});
}
function runHookCommand(h, input) {
	return new Promise((resolve) => {
		const filled = fillTemplate(h.command, input ?? {});
		hookExec(filled, { timeout: Math.min(h.timeoutMs ?? 10000, 60000), windowsHide: true }, (err, stdout, stderr) => {
			resolve({ ok: !err, stdout: String(stdout ?? "").slice(0, 2000), stderr: String(stderr ?? err?.message ?? "").slice(0, 2000), filled });
		});
	});
}
function hooksExtension(hostRef) {
	return (pi) => {
		const hooks = loadHooks();
		if (!hooks.length) return;
		const beforeHooks = hooks.filter((h) => (h.phase ?? "before") === "before");
		const afterHooks = hooks.filter((h) => h.phase === "after");
		const match = (h, tool) => h.on === "*" || h.on === tool || (Array.isArray(h.on) && h.on.includes(tool));
		if (beforeHooks.length) {
			pi.on("tool_call", async (event) => {
				for (const h of beforeHooks.filter((h) => match(h, event.toolName))) {
					const r = await runHookCommand(h, event.input);
					if (!r.ok) {
						console.error(`[hooks] before ${event.toolName} 失败: ${r.stderr.slice(0, 200)}`);
						if (h.blockOnError) return { block: true, reason: `Hook 命令失败：${r.stderr.slice(0, 400)}` };
					}
				}
				return undefined;
			});
		}
		if (afterHooks.length) {
			pi.on("tool_result", async (event) => {
				for (const h of afterHooks.filter((h) => match(h, event.toolName))) {
					await runHookCommand(h, event.input);
				}
				return undefined;
			});
		}
	};
}

export { mcpManager };

/** 危险命令特征（bash / PowerShell / cmd）；full-auto 下命中仍强制确认（P29 护栏） */
const RISKY = [
	/\brm\s+(?:-{1,2}[\w-]+\s+)*-{1,2}[\w-]*[rf]/, // rm -rf / -r / -f
	/\bdel\s+\/[sq]/i,
	/\brmdir\s+\/s/i,
	/\bformat\s+[a-z]:/i,
	/\bmkfs\b/,
	/\bdd\s+if=/,
	/>\s*\/dev\/[sd]/,
	/\bgit\s+push\b[^\n|;]*--force/,
	/\bgit\s+reset\s+--hard\b/, // 丢弃未提交改动
	/\bgit\s+clean\s+-[a-z]*f/, // 丢弃未跟踪文件
	/\bcurl\b[^\n|;]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/,
	/\bwget\b[^\n|;]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/,
	/\bchmod\s+-R\s+777\s+\//,
	/\bshutdown\b|\breboot\b|\bhalt\b/,
	/\b(stop-computer|restart-computer)\b/i,
	/remove-item\s+[^\n]*-recurse[^\n]*-force/i,
	/\breg\s+delete\b/i,
	/\biex\b/i, // PowerShell Invoke-Expression 别名
	/\bdownloadstring\b/i,
	/\b(irm|iwr|invoke-webrequest|invoke-restmethod)\b[^\n|;]*\|\s*(?:iex|invoke-expression)\b/i,
];

/** 安全审计日志（P29）：工具调用落 ~/.pi/agent/audit/<日期>.jsonl，失败不阻断执行 */
function auditLog(hostRef, tool, mode, decision, input) {
	try {
		const dir = path.join(getAgentDir(), "audit");
		fs.mkdirSync(dir, { recursive: true });
		const line = JSON.stringify({
			ts: new Date().toISOString(),
			session: hostRef.session?.sessionId ?? "adhoc",
			tool,
			mode,
			decision,
			input: String(input ?? "").replace(/\s+/g, " ").slice(0, 200),
		}) + "\n";
		fs.appendFileSync(path.join(dir, new Date().toISOString().slice(0, 10) + ".jsonl"), line);
	} catch { /* 尽力而为 */ }
}

export class AgentHost {
	/** @param {import("electron").BrowserWindow} win @param {((event:any)=>void)|null} emitFn P43：子进程模式下的事件出口（null = 直发 win，原行为） */
	constructor(win, emitFn = null) {
		this.win = win;
		this.emitFn = emitFn; // P43
		this.hostPid = typeof process !== "undefined" ? process.pid : null; // P43：所在进程（worker 模式 ≠ main pid）
		this.userDataDir = null; // P41：沙箱根目录由 main 注入（app.getPath("userData")）
		/** @type {ModelRuntime|null} */
		this.modelRuntime = null;
		/** @type {Map<string, object>} P30 后台任务表 */
		this.tasks = new Map();
		this.taskSeq = 0;
		/** @type {import("@earendil-works/pi-coding-agent").AgentSession|null} */
		this.session = null;
		this.unsubscribe = null;
		this.uiSeq = 0;
		/** @type {Map<string, (v:any)=>void>} 扩展 UI 请求挂起表 */
		this.pendingUi = new Map();
		/** @type {Array<{content:string, activeForm:string, status:string}>} P35 任务清单（todo_write 工具维护） */
		this.todos = [];
	}

	#send(event) {
		if (this.emitFn) {
			try { this.emitFn(event); } catch { /* 忽略不可序列化事件 */ }
			return;
		}
		if (!this.win.isDestroyed()) {
			try {
				this.win.webContents.send("agent:event", JSON.parse(JSON.stringify(event)));
			} catch {
				/* 忽略不可序列化事件 */
			}
		}
	}

	/** 供扩展推送自定义事件（P35 todo_update 等） */
	pushEvent(event) {
		this.#send(event);
	}

	/** 初始化模型目录 */
	async init() {
		return this.refreshModels();
	}

	/** 重建 ModelRuntime（models.json/auth.json 变更后调用）；新会话生效 */
	async refreshModels() {
		this.modelRuntime = await ModelRuntime.create();
		const available = await this.modelRuntime.getAvailable();
		const models = available.map((m) => ({
			provider: m.provider,
			id: m.id,
			name: m.name ?? m.id,
			reasoning: !!m.reasoning,
			contextWindow: m.contextWindow ?? 0,
			input: m.input ?? ["text"],
		}));
		return { models };
	}

	#pickModel(provider, id) {
		if (provider && id) {
			const m = this.modelRuntime.getModel(provider, id);
			if (m) return m;
		}
		return undefined;
	}

	/** 构建资源加载器：默认发现 + 内联审批/快照/MCP桥扩展 */
	async #buildLoader(cwd, mcpTools = []) {
		const factories = [approvalExtension(APPROVAL), planPromptExtension(APPROVAL), checkpointExtension(this), todoExtension(this), planExtension(this), officePromptExtension(this), hooksExtension(this)];
		const mcpExt = mcpBridgeExtension(mcpTools);
		if (mcpExt) factories.push(mcpExt);
		const loader = new DefaultResourceLoader({
			cwd: cwd || process.cwd(),
			agentDir: getAgentDir(),
			extensionFactories: factories,
		});
		await loader.reload();
		return loader;
	}

	/**
	 * 启动（或重建）会话。
	 */
	async start(opts = {}) {
		if (this.session) {
			this.unsubscribe?.();
			try {
				await this.session.abort();
			} catch {
				/* 可能本就空闲 */
			}
			this.session.dispose();
			this.session = null;
		}

		const model = this.#pickModel(opts.provider, opts.id);
		const sessionManager = opts.resumeFile ? SessionManager.open(opts.resumeFile) : undefined;
		// workspace === null → 任务模式（不在项目中工作，无项目绑定）；undefined → 默认工作区
		const workspace = sessionManager
			? undefined
			: opts.workspace === null
				? null
				: opts.workspace || path.join(os.homedir(), "openpi-workspace");
		// MCP（P28）：会话启动前就绪工具清单（连接失败不阻断会话）
		let mcpTools = [];
		try {
			mcpTools = await mcpManager.ensure();
			if (mcpTools.length) console.error(`[mcp] ${mcpTools.length} tools ready`);
		} catch (err) {
			console.error(`[mcp] ensure failed: ${err.message ?? err}`);
		}
		const resourceLoader = await this.#buildLoader(workspace, mcpTools);
		setGitWorkspace(workspace === null ? null : (workspace ?? path.join(os.homedir(), "openpi-workspace"))); // P53：注入检查点工作目录（ctx.cwd 不可靠，是进程 cwd）
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: workspace || undefined,
			model,
			thinkingLevel: opts.thinkingLevel || undefined,
			modelRuntime: this.modelRuntime,
			sessionManager,
			resourceLoader,
			customTools: [...webTools, ...browserTools, ...gitTools, buildSubagentTool(this)], // P47 联网 + P52 浏览器 + P53 检查点 + P50 子代理
		});

		// 扩展 UI 桥接（M2）：confirm/select/input → 渲染层模态
		await session.bindExtensions({ mode: "tui", uiContext: this.#uiContext() });

		this.session = session;
		this.workspace = workspace === null ? null : (workspace ?? session.sessionManager?.getCwd?.() ?? undefined);
		this.unsubscribe = session.subscribe((e) => this.#send(e));
		// P35：新会话任务清单归零
		this.todos = [];
		this.pushEvent({ type: "todo_update", todos: [] });

		const m = session.model;
		return {
			sessionId: session.sessionId,
			sessionFile: session.sessionFile ?? null,
			model: m ? { provider: m.provider, id: m.id, name: m.name ?? m.id, contextWindow: m.contextWindow ?? 0, input: m.input ?? ["text"] } : null,
			fallback: modelFallbackMessage ?? null,
		};
	}

	/** 当前会话实时信息（sessionId 在首次落盘后才稳定） */
	info() {
		return {
			sessionId: this.session?.sessionId ?? null,
			sessionFile: this.session?.sessionFile ?? null,
			workspace: this.workspace ?? null,
			hostPid: this.hostPid ?? null, // P43：所在进程（worker 模式 ≠ main pid）
		};
	}

	/** P43：工具名清单（子进程模式下 main 无法直访 session 对象） */
	toolNames() {
		return (this.session?.getAllTools?.() ?? []).map((t) => t.name);
	}

	/** P43：MCP 状态经 worker 查询（避免 main 侧再起一份 mcpManager 双连接） */
	mcpStatus() {
		return { status: mcpManager.status, toolCount: mcpManager.toolsAll().length, ready: mcpManager.ready };
	}
	async mcpRefresh() {
		const tools = await mcpManager.ensure(true);
		return { status: mcpManager.status, toolCount: tools.length };
	}

	/** 扩展 UI 上下文：把对话框请求转发到渲染层，等 IPC 回复 */
	#uiContext() {
		const ask = (payload) =>
			new Promise((resolve) => {
				const id = `ui${++this.uiSeq}`;
				const timer = setTimeout(() => {
					if (this.pendingUi.has(id)) {
						this.pendingUi.delete(id);
						resolve(undefined);
					}
				}, 300000); // 5 分钟超时
				this.pendingUi.set(id, (v) => {
					clearTimeout(timer);
					this.pendingUi.delete(id);
					resolve(v);
				});
				this.#send({ type: "ui_request", id, ...payload });
			});
		return {
			select: (title, options) => ask({ kind: "select", title, options }),
			confirm: (title, message) => ask({ kind: "confirm", title, message }),
			input: (title, placeholder) => ask({ kind: "input", title, placeholder }),
			notify: (message, type) => this.#send({ type: "ui_notify", message, level: type ?? "info" }),
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: () => {},
			setTitle: () => {},
			setEditorText: () => {},
			custom: async () => undefined,
		};
	}

	/** 渲染层回复扩展 UI 请求 */
	resolveUi(id, value) {
		const r = this.pendingUi.get(id);
		if (r) r(value);
	}

	setApprovalMode(mode) {
		if (!["readonly", "auto-edit", "full-auto", "plan"].includes(mode)) throw new Error("未知审批档位");
		APPROVAL.mode = mode;
		return APPROVAL.mode;
	}

	/** P39 命令允许清单：前缀匹配，readonly/auto-edit 档位下命中且非危险的命令免确认直接执行 */
	setApprovalAllowlist(list) {
		APPROVAL.allow = (Array.isArray(list) ? list : [])
			.map((s) => String(s ?? "").trim())
			.filter(Boolean)
			.slice(0, 50);
		return APPROVAL.allow;
	}

	getApprovalMode() {
		return APPROVAL.mode;
	}

	/** P38.5 视觉链路修正：
	 *  ① 剔除空 data 图片 —— 智谱对 image_url 空载荷报「.file必须传入file_id、file_url、file_data至少之一」(1214)
	 *  ② 空文本+图片时补占位文本 —— 智谱对 [text(""),image] 组合报「API 调用参数有误」(1210)，实测 [image] 单独发则正常 */
	#sanitizeVisionPayload(text, images) {
		const imgs = (images ?? []).filter((i) => i && i.data);
		const dropped = (images?.length ?? 0) - imgs.length;
		if (dropped > 0) console.error(`[vision] 剔除 ${dropped} 张空数据图片`);
		const hasText = !!(text && text.trim());
		if (!hasText && imgs.length) text = "请看这张图片。";
		return { text, images: imgs, sendable: hasText || imgs.length > 0 };
	}

	async prompt(text, images = []) {
		this.#ensure();
		const v = this.#sanitizeVisionPayload(text, images);
		if (!v.sendable) return;
		if (v.images.length) await this.session.prompt(v.text, { images: v.images.map((i) => ({ type: "image", data: String(i.data ?? ""), mimeType: String(i.mimeType ?? "image/png") })) });
		else await this.session.prompt(text);
	}

	async steer(text, images = []) {
		this.#ensure();
		const v = this.#sanitizeVisionPayload(text, images);
		if (!v.sendable) return;
		if (v.images.length) await this.session.steer(v.text, v.images.map((i) => ({ type: "image", data: String(i.data ?? ""), mimeType: String(i.mimeType ?? "image/png") })));
		else await this.session.steer(text);
	}

	async abort() {
		if (!this.session) return;
		await this.session.abort();
	}

	async setModel(provider, id) {
		this.#ensure();
		const m = this.modelRuntime.getModel(provider, id);
		if (!m) throw new Error(`模型不存在: ${provider}/${id}`);
		await this.session.setModel(m);
		const cur = this.session.model;
		return { provider: cur?.provider, id: cur?.id, contextWindow: cur?.contextWindow ?? 0 };
	}

	setThinking(level) {
		this.#ensure();
		this.session.setThinkingLevel(level);
		return level;
	}

	/** 手动压缩上下文（M2） */
	async compact() {
		this.#ensure();
		const r = await this.session.compact();
		return {
			tokensBefore: r.tokensBefore,
			tokensAfter: r.estimatedTokensAfter ?? null,
			summaryPreview: r.summary?.replace(/\s+/g, " ").slice(0, 200) ?? "",
		};
	}

	/**
	 * 上下文接力（P24）：旧会话压缩生成交接摘要 → 开新会话（同工作区/模型/思考等级）。
	 * 返回摘要，由渲染层作为种子消息注入新会话继续任务。原会话已归档，可随时回看。
	 */
	async handoff(opts = {}) {
		this.#ensure();
		const old = this.session;
		const oldModel = old.model;
		let thinkingLevel = opts.thinkingLevel ?? undefined;
		if (!thinkingLevel) {
			try { thinkingLevel = old.thinkingLevel ?? undefined; } catch { /* 属性不可读则用默认 */ }
		}
		let summary = null;
		let tokensBefore = null;
		try {
			const r = await old.compact();
			summary = r?.summary ?? null;
			tokensBefore = r?.tokensBefore ?? null;
		} catch { /* 无可压缩内容/压缩失败：summary=null，渲染层据此报错并保留原会话 */ }
		// workspace===null（任务模式）原样传递；start() 内部会 abort+dispose 旧会话
		const info = await this.start({ workspace: this.workspace ?? undefined, provider: oldModel?.provider, id: oldModel?.id, thinkingLevel });
		return { summary, tokensBefore, ...info };
	}

	/* ---- P27：快照（edit/write 前自动，供审核面板回滚 AI 改动） ---- */
	#ckptDir() {
		const sid = this.session?.sessionId ?? "adhoc";
		return path.join(getAgentDir(), "checkpoints", sid);
	}

	/** P30：后台并行任务（独立 session + P41 独立沙箱工作区，与主工作区隔离；无 UI → 危险命令自动拒绝） */
	async startBackground(prompt) {
		if (!this.modelRuntime) throw new Error("模型未就绪");
		const running = [...this.tasks.values()].filter((t) => t.status === "running").length;
		if (running >= 3) throw new Error("后台任务已达上限（3 个并发），等完成后再试");
		// P41：后台任务用独立沙箱目录（不再共享主工作区）；产物在完成通知里带路径
		const sb = createSandbox(sandboxRoot(this.userDataDir), String(prompt).replace(/\s+/g, " ").slice(0, 30));
		const workspace = sb.dir;
		const mcpTools = mcpManager.ready ? mcpManager.toolsAll() : await mcpManager.ensure().catch(() => []);
		const resourceLoader = await this.#buildLoader(workspace, mcpTools);
		const { session } = await createAgentSession({
			cwd: workspace,
			model: this.session?.model ?? this.#pickModel(), // 跟随主会话当前模型（pi 默认链可能选到未配置额度的 provider）
			modelRuntime: this.modelRuntime,
			// 独立会话目录：不污染主会话列表（幽灵会话），同时保留文件可回溯
			sessionManager: SessionManager.create(workspace, path.join(getAgentDir(), "sessions-tasks")),
			resourceLoader,
		});
		await session.bindExtensions({ mode: "tui" }); // 不传 uiContext → hasUI=false：审批弹窗无处弹，危险命令被护栏直接拒绝（空响应根因是模型选择，与 bind 无关）
		const task = {
			id: `t${Date.now()}_${++this.taskSeq}`,
			title: String(prompt).replace(/\s+/g, " ").slice(0, 48),
			status: "running",
			startedAt: Date.now(),
			endedAt: null,
			toolCalls: 0,
			workspace, // P41：沙箱目录（渲染层展示「打开任务文件夹」）
			texts: [], // 最近 assistant 文本（每条≤300 字，保留 3 条）
			sessionFile: session.sessionFile ?? null,
		};
		bindSession(workspace, { sessionId: session.sessionId ?? null, sessionFile: task.sessionFile }); // P41
		this.tasks.set(task.id, task);
		const snapshot = () => ({ ...task, texts: undefined, lastText: task.texts.at(-1) ?? "" });
		const unsubscribe = session.subscribe((e) => {
			try {
				if (e.type === "tool_execution_start") task.toolCalls++;
				else if (e.type === "message_end" && e.message?.role === "assistant") {
					if (e.message.stopReason === "error") task.error = "模型请求失败（检查 API key / 额度 / 代理服务）";
					const text = (e.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("").slice(0, 300);
					if (text) {
						task.texts.push(text);
						if (task.texts.length > 3) task.texts.shift();
					}
				}
			} catch { /* 事件处理失败不影响任务 */ }
		});
		const finish = (status) => {
			if (task.status !== "running") return;
			task.status = status;
			task.endedAt = Date.now();
			unsubscribe?.();
			try { session.dispose(); } catch { /* 尽力释放 */ }
			this.#send({ type: "task_update", task: snapshot() });
		};
		// fire-and-forget：prompt resolve = 跑完
		console.error(`[task:${task.id}] dispatching prompt (${String(prompt).length} chars)`);
		session.prompt(String(prompt)).then(
			() => finish(task.error ? "error" : "done"),
			(err) => {
				task.error = String(err?.message ?? err).slice(0, 200);
				finish("error");
			},
		);
		this.#send({ type: "task_update", task: snapshot() });
		return { id: task.id, title: task.title };
	}

	taskList() {
		return [...this.tasks.values()].map((t) => ({ ...t, texts: undefined, lastText: t.texts.at(-1) ?? "" }));
	}

	snapshotFile(rel) {
		const dir = this.#ckptDir();
		fs.mkdirSync(dir, { recursive: true });
		let snap = null;
		try {
			snap = `${Date.now()}-${path.basename(rel)}`;
			fs.copyFileSync(path.join(this.workspace, rel), path.join(dir, snap));
		} catch {
			snap = null; // 执行前文件不存在
		}
		fs.appendFileSync(path.join(dir, "manifest.jsonl"), JSON.stringify({ t: Date.now(), file: rel, snap }) + "\n");
	}

	listCheckpoints() {
		let raw = "";
		try { raw = fs.readFileSync(path.join(this.#ckptDir(), "manifest.jsonl"), "utf8"); } catch { return []; }
		const counts = new Map();
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line);
				if (e.file && e.snap !== undefined) counts.set(e.file, (counts.get(e.file) ?? 0) + 1);
			} catch { /* 跳过坏行 */ }
		}
		return [...counts.entries()].map(([file, count]) => ({ file, count }));
	}

	restoreCheckpoint(rel) {
		const entries = [];
		try {
			for (const line of fs.readFileSync(path.join(this.#ckptDir(), "manifest.jsonl"), "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					const e = JSON.parse(line);
					if (e.file === rel && e.snap !== undefined) entries.push(e);
				} catch { /* 跳过坏行 */ }
			}
		} catch { /* 无清单 */ }
		if (!entries.length) throw new Error("该文件没有可用快照（可能不是 AI 修改的）");
		const first = entries[0]; // 回滚 AI 改动 = 恢复到 AI 首次碴它之前（多轮编辑全部撤销）
		const abs = path.join(this.workspace ?? "", rel);
		if (first.snap == null) fs.rmSync(abs, { force: true }); // AI 创建的文件：删除
		else fs.copyFileSync(path.join(this.#ckptDir(), first.snap), abs);
		return { ok: true, snap: first.snap };
	}

	async contextFiles() {
		// P26：本会话加载的 AGENTS.md 类指令文件（与 pi 内核同一实现，零偏差）
		try {
			return loadProjectContextFiles({ cwd: this.workspace || os.homedir(), agentDir: getAgentDir() });
		} catch {
			return [];
		}
	}

	/** 会话树（M2）：精简序列化供渲染 */
	tree() {
		this.#ensure();
		const simplify = (n) => {
			const e = n.entry;
			let role = "";
			let preview = "";
			if (e.type === "message") {
				role = e.message?.role ?? "";
				const c = e.message?.content;
				const txt = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join(" ") : "";
				preview = txt.replace(/\s+/g, " ").slice(0, 80);
			} else if (e.type === "compaction" || e.type === "branch_summary") {
				preview = e.summary ?? e.label ?? "";
			} else if (e.type === "label") {
				preview = e.label ?? "";
			}
			return {
				id: e.id,
				type: e.type,
				role,
				ts: e.timestamp,
				label: n.label ?? null,
				preview,
				children: (n.children ?? []).map(simplify),
			};
		};
		return this.session.sessionManager.getTree().map(simplify);
	}

	/** 树导航（M2）：切到历史节点，同文件内分支 */
	async navigateTree(targetId) {
		this.#ensure();
		const r = await this.session.navigateTree(targetId);
		return { cancelled: r.cancelled, editorText: r.editorText ?? null };
	}

	/** 导出当前会话为 HTML（M2），默认写会话文件同目录 */
	async exportHtml(outputPath) {
		this.#ensure();
		return this.session.exportToHtml(outputPath || undefined);
	}

	/** P48：会话累计用量（含成本）——从会话树所有 assistant 消息聚合，含历史轮 */
	getUsage() {
		const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		const walk = (nodes = []) => {
			for (const n of nodes) {
				const e = n?.entry;
				const u = e?.type === "message" && e.message?.role === "assistant" ? e.message?.usage : null;
				if (u) {
					totals.input += u.input ?? 0;
					totals.output += u.output ?? 0;
					totals.cacheRead += u.cacheRead ?? 0;
					totals.cacheWrite += u.cacheWrite ?? 0;
					totals.cost += u.cost?.total ?? 0;
				}
				walk(n?.children ?? []);
			}
		};
		try {
			this.#ensure();
			walk(this.session.sessionManager.getTree());
		} catch {
			/* 会话未就绪 → 返回零值 */
		}
		return totals;
	}

	/** P50：跑一个子代理（独立上下文，只读工具，结果文本返回主会话） */
	async runSubagent(params, signal, onUpdate) {
		if (this._subagentBusy) {
			return { content: [{ type: "text", text: "已有子任务在运行，请等它完成后再派发。" }], details: { ok: false } };
		}
		this._subagentBusy = true;
		const started = Date.now();
		let sub = null;
		const timer = setTimeout(() => sub?.abort?.(), 8 * 60 * 1000); // 硬超时 8 分钟
		try {
			this.#ensure();
			const model = this.session.model;
			onUpdate?.({ type: "text", text: `子任务「${params.task ?? params.prompt.slice(0, 40)}」运行中…` });
			const resourceLoader = await this.#buildLoader(this.workspace, []);
			const { session } = await createAgentSession({
				cwd: this.workspace || undefined,
				agentDir: getAgentDir(), // 与主会话同一配置源（沙箱 env 或真目录），否则 SDK 回退 ~/.pi/agent 导致 baseUrl/auth 脱节（401）
				// 不显式传 model：跟随主会话相同的默认解析链（显式传 session.model 对象会被另一 provider 同名定义覆盖，#98 同类坑）
				modelRuntime: this.modelRuntime,
				sessionManager: SessionManager.inMemory(this.workspace || process.cwd()), // 零文件残留
				resourceLoader,
				tools: ["read", "grep", "find", "ls"], // 只读白名单：子代理不能写/执行，不绕过审批
				customTools: [...webTools, ...gitTools], // P47 联网 + P53 检查点；子代理不给浏览器工具（受控 Chromium 单实例，并发冲突且无必要）
			});
			sub = session;
			const onAbort = () => session.abort().catch(() => {});
			signal?.addEventListener?.("abort", onAbort);
			await session.prompt(String(params.prompt ?? ""));
			signal?.removeEventListener?.("abort", onAbort);
			// 取最后一条 assistant 文本作为结论
			const msgs = session.messages ?? [];
			let result = "";
			for (let i = msgs.length - 1; i >= 0; i--) {
				const m = msgs[i];
				if (m?.role === "assistant") {
					const c = m.content;
					result = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";
					break;
				}
			}
			if (!result) result = "（子任务无文本结论，可能被中断或出错）";
			return {
				content: [{ type: "text", text: `子任务${params.task ? `「${params.task}」` : ""}完成（${Math.round((Date.now() - started) / 1000)}s）：\n\n${result.slice(0, 20000)}` }],
				details: { ok: true, secs: Math.round((Date.now() - started) / 1000) },
			};
		} catch (err) {
			return { content: [{ type: "text", text: `子任务失败：${String(err?.message ?? err).slice(0, 300)}` }], details: { ok: false } };
		} finally {
			clearTimeout(timer);
			try { sub?.dispose?.(); } catch { /* 已释放 */ }
			this._subagentBusy = false;
		}
	}

	/** P49：自动压缩开关（SDK 默认开；持久化到全局 settings；无会话时先缓存，会话就绪后写入） */
	async setAutoCompact(on) {
		this._pendingAutoCompact = !!on;
		try {
			this.#ensure();
			this.session.settingsManager.setCompactionEnabled(!!on);
		} catch { /* 会话未启动：pending 已存，#ensure 后补写 */ }
		return { ok: true, enabled: !!on };
	}

	async getAutoCompact() {
		try {
			this.#ensure();
			return { enabled: this.session.settingsManager.getCompactionEnabled() };
		} catch {
			return { enabled: this._pendingAutoCompact ?? true }; // SDK 默认开
		}
	}

	/** P47：重读设置文件（渲染层保存后调用，websearch 的 Tavily key 即时生效） */
	reloadSettings() {
		try {
			const p = path.join(getAgentDir(), "openpi-settings.json");
			setWebSettings(JSON.parse(fs.readFileSync(p, "utf8")));
			return { ok: true };
		} catch (err) {
			setWebSettings({});
			return { ok: false, error: String(err?.message ?? err) };
		}
	}

	/** 会话改名（M2） */
	setName(name) {
		this.#ensure();
		this.session.setSessionName(String(name).slice(0, 60));
		return this.session.sessionManager.getSessionName();
	}

	/** 历史消息（恢复会话后由 UI 回放渲染） */
	getMessages() {
		this.#ensure();
		return this.session.messages.map((m) => ({
			role: m.role,
			text: Array.isArray(m.content)
				? m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
				: String(m.content ?? ""),
			hasThinking: Array.isArray(m.content) && m.content.some((b) => b.type === "thinking"),
			stopReason: m.stopReason,
		}));
	}

	#ensure() {
		if (!this.session) throw new Error("会话尚未启动");
		if (this._pendingAutoCompact !== null && this._pendingAutoCompact !== undefined) {
			try { this.session.settingsManager.setCompactionEnabled(this._pendingAutoCompact); } catch { /* 持久化失败不阻断会话 */ }
			this._pendingAutoCompact = null;
		}
	}

	dispose() {
		this.unsubscribe?.();
		try {
			this.session?.dispose();
		} catch {
			/* noop */
		}
	}
}

/**
 * MCP 管理器（P28）：连接 ~/.pi/agent/mcp.json 里的 MCP server（stdio / streamable HTTP），
 * 把 server 工具包成 pi 工具。全局共享连接（多窗口/多会话复用），SDK 懒加载（未配置零开销）。
 */
const mcpManager = {
	ready: false,
	clients: new Map(), // name -> { client, mode, tools }
	status: [], // [{ name, mode, ok, toolCount?, error? }]

	toolsAll() {
		const out = [];
		for (const [server, c] of this.clients) {
			for (const t of c.tools) {
				out.push({ server, name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? { type: "object" } });
			}
		}
		return out;
	},

	async ensure(force = false) {
		if (this.ready && !force) return this.toolsAll();
		await this.disconnect();
		let cfg = {};
		try {
			cfg = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "mcp.json"), "utf8"));
		} catch { /* 无配置文件 = 无 MCP */ }
		const servers = cfg.mcpServers ?? {};
		this.status = [];
		if (!Object.keys(servers).length) {
			this.ready = true;
			return [];
		}
		const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
		const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
		const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
		await Promise.allSettled(
			Object.entries(servers).map(async ([name, def]) => {
				const mode = def.command ? "stdio" : def.url ? "http" : null;
				try {
					if (!mode) throw new Error("配置缺少 command 或 url");
					const transport = mode === "stdio"
						? new StdioClientTransport({ command: def.command, args: def.args ?? [], env: def.env && Object.keys(def.env).length ? def.env : undefined })
						: new StreamableHTTPClientTransport(new URL(def.url), { requestInit: { headers: def.headers ?? {} } });
					const client = new Client({ name: "OpenPi Desktop", version: "0.24.0" });
					await client.connect(transport, { timeout: 20000 });
					const { tools } = await client.listTools({}, { timeout: 20000 });
					this.clients.set(name, { client, mode, tools: tools ?? [] });
					this.status.push({ name, mode, ok: true, toolCount: (tools ?? []).length });
				} catch (err) {
					this.status.push({ name, mode: mode ?? "?", ok: false, error: String(err.message ?? err).slice(0, 200) });
				}
			}),
		);
		this.ready = true;
		return this.toolsAll();
	},

	async callTool(server, tool, args) {
		const c = this.clients.get(server);
		if (!c) throw new Error(`MCP server「${server}」未连接（可在设置页重连）`);
		const res = await c.client.callTool({ name: tool, arguments: args ?? {} });
		const content = (res.content ?? []).map((b) => {
			if (b.type === "text") return { type: "text", text: b.text };
			if (b.type === "image") return { type: "image", data: b.data, mimeType: b.mimeType };
			return { type: "text", text: JSON.stringify(b).slice(0, 4000) };
		});
		if (res.isError) content.push({ type: "text", text: "[MCP 工具报告执行失败]" });
		return { content, details: {} };
	},

	async disconnect() {
		for (const [, c] of this.clients) {
			try { await c.client.close(); } catch { /* 尽力关闭 */ }
		}
		this.clients = new Map();
		this.ready = false;
	},
};

/**
 * MCP 桥扩展（内联）：把已连接 server 的工具逐个注册为 pi 工具（mcp__<server>__<tool>）。
 * 工具清单在会话启动前由 mcpManager.ensure() 就绪；新 server 需重连 + 新会话生效。
 */
function mcpBridgeExtension(mcpTools) {
	if (!mcpTools?.length) return null;
	return (pi) => {
		for (const t of mcpTools) {
			const schema = t.inputSchema?.type === "object" ? t.inputSchema : { type: "object", properties: {}, additionalProperties: true };
			pi.registerTool({
				name: `mcp__${t.server}__${t.name}`,
				label: `MCP ${t.server}:${t.name}`,
				description: (t.description || `MCP 工具 ${t.server}/${t.name}`).slice(0, 800),
				promptSnippet: (t.description || `MCP tool ${t.server}/${t.name}`).slice(0, 200),
				parameters: Type.Unsafe(schema),
				async execute(_id, params) {
					return mcpManager.callTool(t.server, t.name, params);
				},
			});
		}
	};
}

/**
 * 快照扩展（内联）：edit/write 工具执行前把目标文件当前内容快照（含 full-auto，与审批无关）。
 * 存储：~/.pi/agent/checkpoints/<sessionId>/manifest.jsonl + <ts>-<basename> 快照；snap=null 表示执行前文件不存在（回滚=删除）。
 * 快照失败不阻断工具执行。
 */
function checkpointExtension(host) {
	return (pi) => {
		pi.on("tool_call", async (event) => {
			const tool = event.toolName;
			if (tool !== "edit" && tool !== "write") return undefined;
			const p = String(event.input?.path ?? event.input?.file_path ?? "");
			if (!p) return undefined;
			const ws = host.workspace;
			if (!ws) return undefined;
			try {
				const abs = path.isAbsolute(p) ? p : path.join(ws, p);
				const rel = path.relative(ws, abs).replace(/\\/g, "/");
				if (!rel || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) return undefined;
				host.snapshotFile(rel);
				host.pushEvent({ type: "turn_file_change", file: rel }); // P39：渲染层本轮改动卡
			} catch {
				/* 忽略快照异常 */
			}
			return undefined;
		});
	};
}

/**
 * 审批扩展（内联）：危险 bash 命令执行前弹图形确认。
 * 通过 ctx.ui.confirm（由 AgentHost.#uiContext 桥接到桌面模态）。
 */
/** 审批模式 holder：readonly 只读 / auto-edit 自动编辑（默认）/ full-auto 全自动 */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "todo_write", "plan_submit", "webfetch", "websearch", "browser_open", "browser_snapshot", "browser_screenshot", "browser_wait", "browser_scroll", "git_status", "git_diff"]); // P52：浏览器/联网只读工具全档位直通（browser_tabs 含 switch/close 故归写类；webfetch/websearch 是只读抓取，不弹审）；P53：git_status/git_diff 只读直通
const WRITE_TOOLS = new Set(["write", "edit"]);
const EXEC_TOOLS = new Set(["bash", "powershell"]);
// P52 浏览器写类工具：readonly/auto-edit 档位弹确认（动真实网页的副作用与执行同级）

function approvalExtension(hostRef) {
	return (pi) => {
		pi.on("tool_call", async (event, ctx) => {
			const mode = hostRef.mode;
			const tool = event.toolName;
			const isExec = EXEC_TOOLS.has(tool);
			const isBrowserWrite = BROWSER_WRITE.has(tool); // P52 浏览器写类
			const cmd = String(event.input?.command ?? event.input?.script ?? "");
			const summary = isExec ? cmd : (event.input?.path ?? event.input?.file_path ?? JSON.stringify(event.input ?? {}).slice(0, 120));
			const risky = isExec && RISKY.some((re) => re.test(cmd));
			// P53：写类操作放行前自动打 git 检查点（快照=改动前状态，供回滚/diff；内部 30s 节流+静默失败）
			const checkpoint = () => {
				if (WRITE_TOOLS.has(tool) || isExec || isBrowserWrite) {
					try { autoCheckpointIfNeeded(null, `${tool}: ${String(summary).slice(0, 80)}`); } catch { /* 不阻断 */ }
				}
			};
			if (!ctx.hasUI) {
				// 后台任务/无 UI 环境：无法弹窗确认，危险命令直接拒绝（P30）
				if (risky) {
					auditLog(hostRef, tool, mode ?? "background", "blocked", cmd);
					return { block: true, reason: "后台任务/无 UI 环境下危险命令被拒绝执行。" };
				}
				return undefined;
			}

			// full-auto 护栏（P29）：普通命令直通（审计 auto-allow），危险命令仍强制确认且不记忆
			if (mode === "full-auto") {
				if (READ_ONLY_TOOLS.has(tool)) return undefined;
				if (risky) {
					auditLog(hostRef, tool, mode, "risk-confirm", cmd);
					const okRisk = await ctx.ui.confirm("⚠ 危险命令确认", `检测到高风险命令（全自动模式下仍需确认）：\n${cmd}\n\n允许执行吗？`);
					if (okRisk) return undefined;
					auditLog(hostRef, tool, mode, "blocked", cmd);
					return { block: true, reason: "用户在 OpenPi Desktop 中拒绝执行该危险命令。" };
				}
				auditLog(hostRef, tool, mode, "auto-allow", summary);
				checkpoint();
				return undefined;
			}
			if (READ_ONLY_TOOLS.has(tool)) return undefined;
			// P39 允许清单：readonly/auto-edit 档位下，命中清单且非危险的命令免确认（full-auto 本就直通，plan 硬拒）
			if (isExec && !risky && APPROVAL.allow.some((p) => cmd.trimStart().startsWith(p))) {
				auditLog(hostRef, tool, mode, "allowlist-allow", cmd);
				checkpoint();
				return undefined;
			}
			// 计划模式（P35）：只读探索 + 清单可写，其余一律硬拒绝（不弹窗），引导 AI 输出计划等待批准
			if (mode === "plan") {
				auditLog(hostRef, tool, "plan", "blocked", summary);
				return {
					block: true,
					reason: `计划模式（Plan）下禁止执行「${tool}」。请只读探索（read/grep/find/ls/todo_write），完成探索后输出完整执行计划：目标、步骤、涉及文件、风险点，然后停下等待用户批准。`,
				};
			}
			// readonly：写文件/执行命令全弹窗；auto-edit：写文件放行，仅危险命令与未知工具弹窗
			const browserLabel = `浏览器写操作「${tool}」`;
			let need = false;
			let label = "";
			if (isBrowserWrite) {
				// P52：浏览器写类（点击/输入/提交）在 readonly/auto-edit 都弹确认，full-auto 直通+审计
				if (mode === "full-auto") {
					auditLog(hostRef, tool, mode, "auto-allow", summary);
					checkpoint();
					return undefined;
				}
				need = true;
				label = `浏览器写操作：${browserLabel}（可能点击/提交真实网页）`;
			} else if (isExec) {
				if (mode === "readonly") {
					need = true;
					label = `执行命令（只读模式）：\n${cmd}`;
				} else if (risky) {
					need = true;
					label = `检测到高风险命令：\n${cmd}`;
				}
			} else if (WRITE_TOOLS.has(tool)) {
				if (mode === "readonly") {
					need = true;
					label = `修改文件（只读模式）：${summary}`;
				} else {
					auditLog(hostRef, tool, mode, "auto-allow", summary);
					checkpoint();
					return undefined;
				}
			} else {
				need = true;
				label = `工具 ${tool} 请求执行`;
			}
			if (!need) {
				auditLog(hostRef, tool, mode, "auto-allow", summary);
				checkpoint();
				return undefined;
			}
			const ok = await ctx.ui.confirm("⚠ 操作审批", `${label}

允许执行吗？（当前档位：${mode === "readonly" ? "只读" : "自动编辑"}）`);
			auditLog(hostRef, tool, mode, ok ? "confirmed" : "blocked", summary);
			if (ok) {
				checkpoint(); // P53：用户确认放行 → 先快照后执行
				return undefined;
			}
			return { block: true, reason: "用户在 OpenPi Desktop 中拒绝执行该操作。" };
		});
	};
}

/**
 * 计划模式系统提示注入（P35，向 Claude Code Plan Mode 取经）：
 * before_agent_start 按轮注入——plan 档位下明确告知 AI 只读探索、输出计划后停下等批准。
 * 官方扩展点：pi.on("before_agent_start") 返回 { systemPrompt } 按链式覆盖本轮提示。
 */
function planPromptExtension(hostRef) {
	return (pi) => {
		pi.on("before_agent_start", async (event) => {
			if (hostRef.mode !== "plan") {
				// P53：非 plan 档位下，git 仓库工作区注入检查点提示（改完代码用 git_diff 自证）
				const cp = checkpointSystemPrompt(event.cwd || hostRef.workspace || process.cwd());
				return cp ? { systemPrompt: event.systemPrompt + cp } : undefined;
			}
			return {
				systemPrompt:
					event.systemPrompt +
					"\n\n## 计划模式（Plan Mode，当前生效）\n" +
					"当前处于计划模式：所有修改文件/执行命令的工具会被直接拒绝。" +
					"请先用只读工具（read/grep/find/ls）探索现状，可用 todo_write 整理探索清单。" +
					"完成探索后，必须调用 plan_submit 工具提交结构化计划（目标/分步/风险点），提交后停下等待用户批准，不要尝试任何修改操作。",
			};
		});
	};
}

/**
 * 办公产物规范注入（P37，待办②）： before_agent_start 按轮注入——
 * ① "写个文档"歧义兑底：默认 Word（.docx）而非 .md；② 产物强制收进工作区 + 回报绝对路径（供渲染层文件卡）。
 */
function officePromptExtension(hostRef) {
	return (pi) => {
		pi.on("before_agent_start", async (event) => {
			const ws = hostRef.workspace;
			const where = ws
				? `当前工作区是 ${ws}，所有产物必须保存到工作区内（推荐 output/ 子目录），禁止写到工作区之外（如 ~/Documents、桌面、下载目录）。`
				: "未绑定工作区时，产物统一保存到默认工作区目录，不要散落到 ~/Documents、桌面等任意位置。";
			return {
				systemPrompt:
					event.systemPrompt +
					"\n\n## 办公产物规范（Office Artifacts，始终生效）\n" +
					"- 用户说「写个文档/写份文档/帮我写」等未指明格式的请求 → 默认生成 Word 文档（.docx，用 docx 技能），不要生成 .md；只有用户明确要 markdown 才生成 .md。\n" +
					"- 「表格/Excel」→ xlsx 技能；「幻灯片/PPT」→ pptx 技能；「PDF」→ pdf 技能；「压缩/打包/归档/解压/解压到」或用户给了压缩包（zip/7z/tar.gz 等）→ archive 技能；生成前先读对应技能的 SKILL.md。\n" +
					`- ${where}\n` +
					"- 回复中报告每个产物的完整绝对路径（如 C:\\workspace\\output\\报告.docx），用户界面上会渲染成可点击的文件卡。",
			};
		});
	};
}

/**
 * 计划提交扩展（P35.1）：AI 调用 plan_submit 提交结构化计划 → 渲染层渲染成可审阅的计划卡片。
 * 只读档工具；重复调用以最后一次为准（AI 修改计划后重新提交）。
 */
function planExtension(host) {
	return (pi) => {
		pi.registerTool({
			name: "plan_submit",
			label: "提交计划",
			description:
				"仅在计划模式（Plan Mode）下使用：探索完成后，用本工具提交结构化执行计划（目标、分步、风险点），提交后停下等待用户批准。不要在其他模式调用。",
			promptSnippet: "计划模式下提交结构化执行计划，等待用户批准",
			promptGuidelines: [
				"在计划模式下，探索完成后必须调用 plan_submit 提交计划（含 goal、steps、risks），提交后停下等待批准，不要开始任何修改。",
			],
			parameters: Type.Object({
				goal: Type.String({ description: "本次任务的目标（一句话）" }),
				steps: Type.Array(
					Type.Object({
						title: Type.String({ description: "步骤标题（祈使句，如：新增 mul 函数）" }),
						detail: Type.Optional(Type.String({ description: "补充说明（涉及文件/方式）" })),
					}),
					{ description: "分步操作，按执行顺序" },
				),
				risks: Type.Optional(Type.String({ description: "风险点/注意事项（可省）" })),
			}),
			async execute(_id, params) {
				const plan = {
					goal: String(params?.goal ?? "").slice(0, 300),
					steps: (Array.isArray(params?.steps) ? params.steps : []).slice(0, 20).map((s, i) => ({
						title: String(s?.title ?? `第 ${i + 1} 步`).slice(0, 200),
						detail: String(s?.detail ?? "").slice(0, 300),
					})),
					risks: String(params?.risks ?? "").slice(0, 500),
				};
				if (!plan.goal || !plan.steps.length) {
					return { content: [{ type: "text", text: "计划不完整：需要 goal 和至少一个 step。" }] };
				}
				host.pushEvent({ type: "plan_submit", plan });
				return { content: [{ type: "text", text: `计划已提交用户审阅（${plan.steps.length} 步）。停下等待批准，不要开始执行。` }], details: {} };
			},
		});
	};
}

/**
 * 任务清单扩展（P35，向 Claude Code TodoWrite 取经）：
 * AI 在多步任务中调用 todo_write 维护清单，状态经 agent:event 推给渲染层渲染进度条。
 * 只读工具档（不弹审批），状态存 host.todos，会话切换时由 start() 清空。
 */
function todoExtension(host) {
	return (pi) => {
		pi.registerTool({
			name: "todo_write",
			label: "任务清单",
			description:
				"维护当前任务的待办清单（全量覆盖式更新）。接到 3 步以上的任务时先建立清单；每完成一项立即把状态更新为 done，并推进下一项为 in_progress。简单单步操作不要用清单。",
			promptSnippet: "维护当前任务的待办清单（多步任务先建清单并实时勾选进度）",
			promptGuidelines: [
				"接到 3 步以上的任务时，先调用 todo_write 建立清单（每项含 content 与 activeForm），执行中每完成一项就把对应项状态改为 done，始终保持恰有一项 in_progress。",
				"简单的一次性操作（单文件小改、问答）不要用清单。",
			],
			parameters: Type.Object({
				todos: Type.Array(
					Type.Object({
						content: Type.String({ description: "待办事项（完成态描述，如：接入登录接口）" }),
						activeForm: Type.String({ description: "进行中时的进行时描述，如：正在接入登录接口" }),
						status: Type.Unsafe({ type: "string", enum: ["pending", "in_progress", "done"] }),
					}),
					{ description: "完整清单（全量覆盖式更新）" },
				),
			}),
			async execute(_id, params) {
				const list = Array.isArray(params?.todos) ? params.todos : [];
				const todos = list.slice(0, 50).map((t, i) => ({
					content: String(t?.content ?? `第 ${i + 1} 项`).slice(0, 200),
					activeForm: String(t?.activeForm ?? t?.content ?? `第 ${i + 1} 项`).slice(0, 200),
					status: ["pending", "in_progress", "done"].includes(t?.status) ? t.status : "pending",
				}));
				host.todos = todos;
				host.pushEvent({ type: "todo_update", todos });
				const done = todos.filter((t) => t.status === "done").length;
				const cur = todos.find((t) => t.status === "in_progress");
				return { content: [{ type: "text", text: `清单已更新：${done}/${todos.length} 完成${cur ? `，当前：${cur.activeForm}` : ""}` }], details: {} };
			},
		});
	};
}
