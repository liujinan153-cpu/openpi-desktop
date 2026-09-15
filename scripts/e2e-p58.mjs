// E2E P58：验证门槛项目化 + 轻量代码诊断
//   ① verify_init 检测项目类型 → 返回建议 hooks 配置（checker 命令，支持 ESM）
//   ② AI 把配置写入 <工作区>/.openpi/hooks.json（项目级 hooks 热生效）
//   ③ AI 写坏 .mjs 文件 → 门槛拦截（「验证门槛」错误）→ 修复 → 通过
//   ④ code_diag 自证 ESM 文件语法通过；code_symbols 符号导航可用
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9358;
const LLM = 9498;
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
		// 显式状态机：c1 verify_init → 写项目级 hooks.json → c2 写坏 ESM → c3 修复 → c4 code_diag → c5 code_symbols → finish
		const ws = path.join(os.homedir(), "openpi-workspace");
		const mjsPath = path.join(ws, "p58-gate.mjs");
		if (last?.role === "user" && textOf(last).includes("P58-FLOW-A")) {
			toolCall("c1", "verify_init", {});
		} else if (last?.role === "tool" && !globalThis.p58wroteHooks) {
			globalThis.p58wroteHooks = true;
			globalThis.p58initText = textOf(last);
			const jsonText = textOf(last).match(/\[[\s\S]*\]/)?.[0];
			if (!jsonText) { finish("FAIL0 verify_init 未返回建议配置 END58"); return; }
			const hooks = JSON.parse(jsonText);
			fs.mkdirSync(path.join(ws, ".openpi"), { recursive: true });
			fs.writeFileSync(path.join(ws, ".openpi", "hooks.json"), JSON.stringify(hooks, null, 2));
			toolCall("c2", "write", { path: mjsPath, content: "export const gate = { broken" }); // 故意写坏 ESM
		} else if (last?.role === "tool" && !globalThis.p58wrote) {
			globalThis.p58wrote = true;
			globalThis.p58first = textOf(last);
			if (process.env.P58_DUMP) console.error("[p58dump] 写坏结果:", textOf(last).slice(0, 300));
			toolCall("c3", "write", { path: mjsPath, content: "export const gate = { ok: true };\n" }); // 修复
		} else if (last?.role === "tool" && !globalThis.p58fixed) {
			globalThis.p58fixed = true;
			globalThis.p58second = textOf(last);
			toolCall("c4", "code_diag", { path: "p58-gate.mjs" }); // 自证
		} else if (last?.role === "tool" && !globalThis.p58diag) {
			globalThis.p58diag = true;
			globalThis.p58diagText = textOf(last);
			toolCall("c5", "code_symbols", { path: "p58-gate.mjs" });
		} else if (last?.role === "tool" && !globalThis.p58sym) {
			globalThis.p58sym = true;
			const gate = (globalThis.p58first || "").includes("验证门槛") ? 1 : 0;
			const diagOk = (globalThis.p58diagText || "").includes("通过") ? 1 : 0;
			finish(`OK8 init=${(globalThis.p58initText || "").includes("hooks.json") ? 1 : 0} gate=${gate} fixed=${(globalThis.p58second || "").includes("验证门槛") ? 0 : 1} diag=${diagOk} sym=${textOf(last).includes("gate") ? 1 : 0} END58`);
		} else {
			finish("收到。");
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
llm.listen(LLM, "127.0.0.1");

/* ---- 前置：workspace（含 package.json 供项目类型识别）+ 清残留 ---- */
const ws = path.join(os.homedir(), "openpi-workspace");
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "openpi-ws", version: "1.0.0" }, null, 2));
fs.rmSync(path.join(ws, ".openpi", "hooks.json"), { force: true });
fs.rmSync(path.join(ws, "p58-gate.mjs"), { force: true });
console.log("[前置] workspace 就绪");

/* ---- 沙箱 agentDir（无全局 hooks.json，只走项目级） ---- */
const agentDir = path.join(os.tmpdir(), "p58-agent");
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
const lastText = (anchor) => ev(`(async () => {
	const btn = () => document.querySelector("#btn-send")?.textContent;
	for (let i = 0; i < 20; i++) { if (btn() === "■") break; await new Promise(r => setTimeout(r, 500)); }
	for (let i = 0; i < 240; i++) { await new Promise(r => setTimeout(r, 500)); if (btn() !== "■") break; }
	const asst = [...document.querySelectorAll(".msg.assistant")].filter(m => m.textContent.includes("${anchor}"));
	if (!asst.length) return "[EMPTY] btn=" + btn() + " asst气泡=" + document.querySelectorAll(".msg.assistant").length;
	return asst.at(-1).textContent.slice(0, 800);
})()`);

/* ⓪ 切到 git 工作区会话 */
await ev(`startSession(${JSON.stringify(ws)})`);
await sleep(1500);
ok("⓪ 切到工作区会话", true);

/* ① 全链路 */
await ev(`(() => { sendText("P58-FLOW-A 给项目配好验证门槛然后写个 mjs 文件保证语法通过"); return 1; })()`);
const t1 = await lastText("OK8");
ok("① verify_init 检测项目类型并给出配置", t1.includes("init=1"), t1.slice(0, 120));
ok("② 项目级 hooks 热生效并拦截坏 ESM", t1.includes("gate=1"), t1.slice(0, 120));
ok("③ 修复后通过门槛", t1.includes("fixed=1"), t1.slice(0, 120));
ok("④ code_diag 自证通过 + code_symbols 可用", t1.includes("diag=1") && t1.includes("sym=1"), t1.slice(0, 120));
if (process.env.P58_DUMP) console.log("[p58dump] t1:", t1.slice(0, 400));

/* ⑤ 磁盘铁证 */
const hooksJson = fs.existsSync(path.join(ws, ".openpi", "hooks.json")) ? fs.readFileSync(path.join(ws, ".openpi", "hooks.json"), "utf8") : "";
const finalMjs = fs.existsSync(path.join(ws, "p58-gate.mjs")) ? fs.readFileSync(path.join(ws, "p58-gate.mjs"), "utf8") : "";
ok("⑤ 项目级 hooks.json 落盘且含 checker", hooksJson.includes("verify-check.cjs") && hooksJson.includes("blockOnError"), hooksJson.slice(0, 60));
ok("⑥ 磁盘文件为修复后代码", finalMjs.includes("gate") && finalMjs.includes("ok: true"), JSON.stringify(finalMjs.slice(0, 60)));

/* 清理 */
try { client.close(); } catch { /* 忽略 */ }
try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 已退出 */ }
await sleep(1500);
llm.close();
console.log(fails === 0 ? `✅ e2e-p58 ${total} 过 0 败` : `❌ e2e-p58 ${total - fails} 过 ${fails} 败`);
process.exit(fails === 0 ? 0 : 1);
