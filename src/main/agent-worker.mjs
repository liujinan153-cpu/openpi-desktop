/**
 * P43：Agent 独立进程入口（utilityProcess.fork）。
 * AgentHost 原样在子进程运行（pi SDK 零改动），主进程只做 MessagePort 转发。
 * 协议：
 *   main → worker: { seq, method, args }            → 方法调用（JSON 结构化克隆）
 *   worker → main: { seq, ok, result, workspace }   → 应答（workspace 供 proxy 缓存同步）
 *   worker → main: { evt: true, event }             → Pi 事件流（原样转发给渲染层）
 * 崩溃恢复：main 侧 AgentProxy 检测 exit → 下次调用自动重新 fork。
 */
import { AgentHost } from "./agent-host.mjs";
import os from "node:os";
import { setWebSettings } from "./web-tools.mjs";
import fs from "node:fs";
import path from "node:path";

// P47：设置文件（Tavily key 等）——worker 启动时读一次，保存后重启会话/进程生效
try {
	const settingsPath = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "openpi-settings.json");
	setWebSettings(JSON.parse(fs.readFileSync(settingsPath, "utf8")));
} catch { /* 无设置文件属正常 */ }

const port = process.parentPort; // Electron utilityProcess：MessagePort 在 process.parentPort（非 worker_threads）

let host = null;

function post(msg) {
	try {
		port.postMessage(msg);
	} catch (err) {
		console.error(`[agent-worker] post 失败: ${err.message ?? err}`);
	}
}

/** 结构化克隆不出去的结果兜底转 JSON */
function clean(value) {
	try {
		// 试探一次结构化克隆（postMessage 时才真正校验，这里先 JSON 往返保平安）
		return JSON.parse(JSON.stringify(value ?? null));
	} catch {
		return null;
	}
}

port.on("message", async (e) => {
	const { seq, method, args } = e.data ?? {};
	if (!seq || typeof method !== "string") return;
	try {
		if (!host) {
			// boot：首个请求前建 host；emitFn = 事件转发
			host = new AgentHost({ isDestroyed: () => true }, (event) => post({ evt: true, event: clean(event) }));
		}
		if (method === "__boot") { // P43：main 注入 userDataDir（P41 沙箱根目录依赖它）
			host.userDataDir = args?.[0] ?? null;
			post({ seq, ok: true, result: { pid: process.pid } });
			return;
		}
		const fn = host[method];
		if (typeof fn !== "function") throw new Error(`未知方法: ${method}`);
		const result = await fn.apply(host, Array.isArray(args) ? args : []);
		post({ seq, ok: true, result: clean(result), workspace: host.workspace ?? null });
	} catch (err) {
		post({ seq, ok: false, error: String(err?.message ?? err).slice(0, 500) });
	}
});

console.error(`[agent-worker] ready pid=${process.pid}`);
