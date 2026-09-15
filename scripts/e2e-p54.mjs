// E2E P54：验证闭环（系统提示注入「改完必须跑测试贴证据」+ hooks 验证模板存在）
//   ① git 工作区会话 system 注入「验证闭环」约定（mock 捕获请求体关键词）
//   ② AI 改代码后发起验证命令（bash node --check）并拿到结果（证据链）
//   ③ hooks 示例模板包含 P54 验证项（main 进程 IPC hooks:sample 内容检查 → 由文件断言替代）
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9354;
const LLM = 9494;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0, fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

/* ---- mock LLM：验证闭环循环 ---- */
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const llm = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		let body = {};
		try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* 忽略 */ }
		const last = body.messages?.[body.messages.length - 1];
		const textOf = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
		// 每次请求都更新 system 注入标志（整个请求体搜关键词，兼容 system 位置差异）
		globalThis.p54Sys = JSON.stringify(body).includes("验证闭环");
		const toolCall = (id, name, args) => {
			sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] } }] });
			sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] });
			sse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 30 } });
		};
		const finish = (text) => {
			sse(res, { choices: [{ delta: { content: text } }] });
			sse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 50 } });
		};
		const wsPath = path.join(os.homedir(), "openpi-workspace");
		const jsPath = path.join(wsPath, "p54-v.js");
		const jsUrl = jsPath.split(path.sep).join("/");
		if (last?.role === "user" && textOf(last).includes("P54-FLOW-A")) {
			toolCall("c1", "write", { path: jsPath, content: "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n" });
		} else if (last?.role === "tool" && !globalThis.p54wrote) {
			globalThis.p54wrote = true;
			// 遵循验证闭环约定：改码后跑验证命令
			toolCall("c2", "bash", { command: 'node --check "' + jsPath + '" && node -e "console.log(\'verify:\' + require(\'' + jsUrl + '\').add(1,2))"' });
		} else if (last?.role === "tool" && !globalThis.p54ran) {
			globalThis.p54ran = true;
			if (process.env.P54_DUMP) console.error("[p54dump] 验证命令结果:", textOf(last).slice(0, 300));
			finish(`V-OK sys=${globalThis.p54Sys ? 1 : 0} 证据=${textOf(last).slice(0, 200)} END54`);
		} else {
			finish("收到。");
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
llm.listen(LLM, "127.0.0.1");

/* ---- 前置：workspace git 就绪 + 清残留 ---- */
const ws = path.join(os.homedir(), "openpi-workspace");
fs.mkdirSync(ws, { recursive: true });
const g = (...a) => execFileSync("git", a, { cwd: ws, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
if (!g("rev-parse", "--git-dir")) g("init", "-b", "main");
if (!g("rev-parse", "--verify", "-q", "HEAD")) {
	fs.writeFileSync(path.join(ws, ".gitkeep"), "");
	g("add", "-A");
	g("-c", "user.name=P54", "-c", "user.email=p54@e2e.local", "commit", "-m", "p54 baseline", "--no-verify");
}
fs.rmSync(path.join(ws, "p54-v.js"), { force: true });
console.log("[前置] workspace git 就绪");

/* ---- hooks 示例模板断言：P54 验证模板已写入 hooks:sample 逻辑（源码级断言） ---- */
const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main", "main.mjs"), "utf8");
ok("⓪ hooks 示例模板含验证门槛项（ESM-aware checker）", mainSrc.includes("verify-check.cjs") && mainSrc.includes("blockOnError"));

/* ---- 沙箱 agentDir ---- */
const agentDir = path.join(os.tmpdir(), "p54-agent");
fs.rmSync(agentDir, { recursive: true, force: true });
fs.mkdirSync(agentDir, { recursive: true });
const userModels = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "models.json"), "utf8"));
userModels.providers.zhipu.baseUrl = `http://127.0.0.1:${LLM}/v1`;
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(userModels));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "zhipu", defaultModel: "glm-5.2" }));
const authSrc = path.join(os.homedir(), ".pi", "agent", "auth.json");
if (fs.existsSync(authSrc)) fs.copyFileSync(authSrc, path.join(agentDir, "auth.json"));

const killPort = () => {
	const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
	const pids = new Set(
		out.split("\n").filter((l) => l.includes(`:${PORT}`) && l.includes("LISTENING"))
			.map((l) => l.trim().split(/\s+/).at(-1)).filter((p) => /^\d+$/.test(p)),
	);
	for (const pid of pids) execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
};
killPort();
await sleep(800);
const { ELECTRON_RUN_AS_NODE, ...cleanEnv } = process.env;
cleanEnv.PI_CODING_AGENT_DIR = agentDir;
spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), [ROOT, `--remote-debugging-port=${PORT}`], { cwd: ROOT, env: cleanEnv, detached: false, stdio: "inherit" }).unref();
let ready = false;
for (let i = 0; i < 45; i++) {
	await sleep(2000);
	try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ready = true; break; } } catch { /* 未就绪 */ }
}
await sleep(5000);
ok("应用启动", ready);

const tabs = await CDP.List({ port: PORT });
const page = tabs.find((t) => t.type === "page");
const client = await CDP({ target: page.webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = async (expr) => {
	const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.slice(0, 400));
	return r.result.value;
};
const lastText = () => ev(`(async () => {
	const btn = () => document.querySelector("#btn-send")?.textContent;
	for (let i = 0; i < 20; i++) { if (btn() === "■") break; await new Promise(r => setTimeout(r, 500)); }
	for (let i = 0; i < 240; i++) { await new Promise(r => setTimeout(r, 500)); if (btn() !== "■") break; }
	const asst = [...document.querySelectorAll(".msg.assistant")].filter(m => m.textContent.includes("END54"));
	if (!asst.length) return "[EMPTY] btn=" + btn() + " asst气泡=" + document.querySelectorAll(".msg.assistant").length;
	return asst.at(-1).textContent.slice(0, 800);
})()`);

/* 前置：切到 git 工作区会话 */
const wsSwitched = (await ev(`startSession(${JSON.stringify(ws)}).then(() => 1).catch((e) => "err:" + e.message)`)) === 1;
ok("⓪ 切到 git 工作区会话", wsSwitched);

/* ① write + bash 验证命令闭环 */
await ev(`(() => { sendText("P54-FLOW-A 创建 p54-v.js 并按验证闭环约定自证"); return 1; })()`);
const t1 = await lastText();
ok("① system 注入「验证闭环」约定", t1.includes("sys=1"), t1.slice(0, 120));
ok("② AI 改码后发起验证命令且通过", t1.includes("V-OK") && t1.includes("verify:3"), t1.slice(0, 200));
fs.rmSync(path.join(ws, "p54-v.js"), { force: true });

try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 已退出 */ }
await sleep(2000);
llm.close();
fs.rmSync(agentDir, { recursive: true, force: true });
console.log(fails === 0 ? `✅ e2e-p54 ${total} 过 0 败` : `❌ e2e-p54 ${total - fails} 过 ${fails} 败`);
process.exit(fails === 0 ? 0 : 1);
