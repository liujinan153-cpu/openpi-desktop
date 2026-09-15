// E2E P57：验证硬闭环（hooks after + blockOnError → 工具结果改写为错误，强制模型修复）
//   ① AI 写坏 JS（语法错误）→ node --check 失败 → write 结果被改写为 isError +「验证门槛」
//   ② AI 收到错误后修复重写 → hook 通过 → 结果正常
//   ③ 文件最终内容 = 修复后代码（磁盘铁证）
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9357;
const LLM = 9497;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0, fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

/* ---- mock LLM ---- */
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
		const toolCall = (id, name, args) => {
			sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] } }] });
			sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] });
			sse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 30 } });
		};
		const finish = (text) => {
			sse(res, { choices: [{ delta: { content: text } }] });
			sse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 50 } });
		};
		const jsPath = path.join(os.homedir(), "openpi-workspace", "p57-gate.js");
		if (last?.role === "user" && textOf(last).includes("P57-FLOW-A")) {
			// 第一次：故意写坏（语法错误）
			toolCall("c1", "write", { path: jsPath, content: "const gate = { broken" });
		} else if (last?.role === "tool" && !globalThis.p57wrote) {
			globalThis.p57wrote = true;
			globalThis.p57first = textOf(last);
			if (process.env.P57_DUMP) console.error("[p57dump] 首次 write 结果:", textOf(last).slice(0, 400));
			// 遵守验证门槛：修复重写
			toolCall("c2", "write", { path: jsPath, content: "const gate = { ok: true };\nmodule.exports = { gate };\n" });
		} else if (last?.role === "tool" && !globalThis.p57fixed) {
			globalThis.p57fixed = true;
			globalThis.p57second = textOf(last);
			finish(`OK7 gate=${globalThis.p57first.includes("验证门槛") ? 1 : 0} err1=${JSON.stringify(body.messages.at(-1)).includes('"isError":true') || globalThis.p57first.includes("验证门槛") ? 1 : 0} fixed=${globalThis.p57second.includes("验证门槛") ? 0 : 1} END57`);
		} else {
			finish("收到。");
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
llm.listen(LLM, "127.0.0.1");

/* ---- 前置：workspace 就绪 + 清残留 ---- */
const ws = path.join(os.homedir(), "openpi-workspace");
fs.mkdirSync(ws, { recursive: true });
fs.rmSync(path.join(ws, "p57-gate.js"), { force: true });

/* ---- 沙箱 agentDir（含 hooks.json：write/edit after node --check blockOnError=true） ---- */
const agentDir = path.join(os.tmpdir(), "p57-agent");
fs.rmSync(agentDir, { recursive: true, force: true });
fs.mkdirSync(agentDir, { recursive: true });
const userModels = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "models.json"), "utf8"));
userModels.providers.zhipu.baseUrl = `http://127.0.0.1:${LLM}/v1`;
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(userModels));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "zhipu", defaultModel: "glm-5.2" }));
const authSrc = path.join(os.homedir(), ".pi", "agent", "auth.json");
if (fs.existsSync(authSrc)) fs.copyFileSync(authSrc, path.join(agentDir, "auth.json"));
fs.writeFileSync(path.join(agentDir, "hooks.json"), JSON.stringify([
	{ _note: "P57 验证硬门槛 e2e", on: ["write", "edit"], phase: "after", command: 'node --check "{{input.path}}"', timeoutMs: 15000, blockOnError: true },
], null, 2));

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
const lastText = (anchor) => ev(`(async () => {
	const btn = () => document.querySelector("#btn-send")?.textContent;
	for (let i = 0; i < 20; i++) { if (btn() === "■") break; await new Promise(r => setTimeout(r, 500)); }
	for (let i = 0; i < 240; i++) { await new Promise(r => setTimeout(r, 500)); if (btn() !== "■") break; }
	const asst = [...document.querySelectorAll(".msg.assistant")].filter(m => m.textContent.includes("${anchor}"));
	if (!asst.length) return "[EMPTY] btn=" + btn() + " asst气泡=" + document.querySelectorAll(".msg.assistant").length;
	return asst.at(-1).textContent.slice(0, 800);
})()`);

/* ⓪ 切到 git 工作区会话（沙箱 boot 是任务模式，必须先切） */
await ev(`startSession(${JSON.stringify(ws)})`);
await sleep(1500);
ok("⓪ 切到工作区会话", true);

/* ① 全链路：写坏 → 门槛拦截 → 修复 → 通过 */
await ev(`(() => { sendText("P57-FLOW-A 写一个 js 文件并保证它通过语法检查"); return 1; })()`);
const t1 = await lastText("OK7");
ok("① 门槛拦截坏代码并强制修复", t1.includes("OK7") && t1.includes("gate=1") && t1.includes("fixed=1"), t1.slice(0, 200));
if (process.env.P57_DUMP) console.log("[p57dump] t1:", t1.slice(0, 400));

/* ② 磁盘铁证：文件最终内容是修复后的代码 */
const finalContent = fs.existsSync(path.join(ws, "p57-gate.js")) ? fs.readFileSync(path.join(ws, "p57-gate.js"), "utf8") : "";
ok("② 磁盘文件为修复后代码", finalContent.includes("gate") && finalContent.includes("ok: true"), JSON.stringify(finalContent.slice(0, 80)));

/* 清理 */
try { client.close(); } catch { /* 忽略 */ }
try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 已退出 */ }
await sleep(1500);
llm.close();
console.log(fails === 0 ? `✅ e2e-p57 ${total} 过 0 败` : `❌ e2e-p57 ${total - fails} 过 ${fails} 败`);
process.exit(fails === 0 ? 0 : 1);
