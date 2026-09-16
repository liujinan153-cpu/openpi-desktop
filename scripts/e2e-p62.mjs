// E2E P62：编程轻量三件套
//   ① repo map 注入：mock LLM 收到的 system 提示含「工作区地图」（目录树，node_modules 被滤）
//   ② run_tests：改前跑测试失败（字符串拼接坑）→ ast_edit 语法树替换修复 → run_tests 通过
//   ③ ast_edit：预览匹配数 → apply 落盘 → 磁盘铁证
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9362;
const LLM = 9502;
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
		if (process.env.P62_DUMP) console.error(`[p62mock] 请求: tools=${(body.messages ?? []).length}条 last=${(() => { const l = (body.messages ?? []).at(-1); return l ? String(l.role) + ":" + String(typeof l.content === "string" ? l.content : JSON.stringify(l.content)).slice(0, 100) : "none"; })()}`);
		const last = body.messages?.[body.messages.length - 1];
		const systemMsg = body.messages?.find((m) => m.role === "system");
		const sysText = typeof systemMsg?.content === "string" ? systemMsg.content : JSON.stringify(systemMsg?.content ?? "");
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
		// 状态机：c1 run_tests(改前失败) → c2 ast_edit 预览 → c3 ast_edit apply → c4 run_tests(通过) → finish
		if (last?.role === "user" && textOf(last).includes("P62-FLOW-A")) {
			globalThis.p62sys = sysText;
			toolCall("c1", "run_tests", {});
		} else if (last?.role === "tool" && !globalThis.p62before) {
			globalThis.p62before = textOf(last);
			toolCall("c2", "ast_edit", { pattern: "return $A + $B", rewrite: "return Number($A) + Number($B)", path: "p62-calc.js" });
		} else if (last?.role === "tool" && !globalThis.p62preview) {
			globalThis.p62preview = textOf(last);
			toolCall("c3", "ast_edit", { pattern: "return $A + $B", rewrite: "return Number($A) + Number($B)", path: "p62-calc.js", apply: true });
		} else if (last?.role === "tool" && !globalThis.p62applied) {
			globalThis.p62applied = textOf(last);
			toolCall("c4", "run_tests", {});
		} else if (last?.role === "tool" && !globalThis.p62after) {
			globalThis.p62after = textOf(last);
			const rm = globalThis.p62sys?.includes("工作区地图") ? 1 : 0;
			const rmClean = globalThis.p62sys?.includes("node_modules/") ? 0 : 1;
			finish(
				`OK6 map=${rm}/${rmClean} before=${(globalThis.p62before || "").includes("失败") || (globalThis.p62before || "").includes("failing") ? 1 : 0} ` +
				`preview=${(globalThis.p62preview || "").includes("1 处匹配") ? 1 : 0} applied=${(globalThis.p62applied || "").includes("已应用 1 处") ? 1 : 0} ` +
				`after=${(globalThis.p62after || "").includes("测试通过") ? 1 : 0} END62`,
			);
		} else {
			finish("收到。");
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
llm.listen(LLM, "127.0.0.1");

/* ---- 前置：workspace（npm 项目 + calc 测试靶子） + 清残留 ---- */
const ws = path.join(os.homedir(), "openpi-workspace");
fs.mkdirSync(path.join(ws, "test"), { recursive: true });
fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "openpi-ws", version: "1.0.0", scripts: { test: "node test/calc.test.js" } }, null, 2));
fs.writeFileSync(path.join(ws, "p62-calc.js"), "function calcAdd(a, b) {\n  return a + b;\n}\nmodule.exports = { calcAdd };\n");
fs.writeFileSync(path.join(ws, "test", "calc.test.js"), `const assert = require("assert");
const { calcAdd } = require("../p62-calc.js");
assert.equal(calcAdd("1", 2), 3); // 数字与数字符串相加应得数值和
console.log("ALL TESTS PASSED");
`);
console.log("[前置] workspace 靶子就绪");

/* ---- 沙箱 agentDir ---- */
const agentDir = path.join(os.tmpdir(), "p62-agent");
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
await ev(`(() => { sendText("P62-FLOW-A 先跑测试看现状，用结构化编辑修掉类型问题，再跑测试确认"); return 1; })()`);
const t1 = await lastText("OK6");
ok("① repo map 注入系统提示（node_modules 已滤）", t1.includes("map=1/1"), t1.slice(0, 120));
ok("② run_tests 改前如实报失败", t1.includes("before=1"), t1.slice(0, 120));
ok("③ ast_edit 预览匹配数", t1.includes("preview=1"), t1.slice(0, 120));
ok("④ ast_edit apply 落盘", t1.includes("applied=1"), t1.slice(0, 120));
ok("⑤ run_tests 修复后通过", t1.includes("after=1"), t1.slice(0, 120));
if (process.env.P62_DUMP) console.log("[p62dump] t1:", t1.slice(0, 500));

/* ⑥ 磁盘铁证 */
const calc = fs.existsSync(path.join(ws, "p62-calc.js")) ? fs.readFileSync(path.join(ws, "p62-calc.js"), "utf8") : "";
ok("⑥ 磁盘文件为修复后代码", calc.includes("Number($A)".replace("$A", "a")) || calc.includes("Number(a)"), JSON.stringify(calc.slice(0, 80)));

/* 清理 */
try { client.close(); } catch { /* 忽略 */ }
try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 已退出 */ }
await sleep(1500);
llm.close();
console.log(fails === 0 ? `✅ e2e-p62 ${total} 过 0 败` : `❌ e2e-p62 ${total - fails} 过 ${fails} 败`);
process.exit(fails === 0 ? 0 : 1);
