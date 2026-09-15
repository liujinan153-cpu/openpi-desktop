// E2E P49：auto-compact 开关 + P50 子代理 + P51 Hooks
//   ① subagent：主会话派发子任务 → 子代理独立上下文跑完 → 结论回主会话
//   ② subagent 只读白名单生效（无 bash/write 工具卡）
//   ③ hooks：bash 调用后自动执行用户命令（副作用文件出现）
//   ④ auto-compact 开关 RPC 往返 + 设置页卡片
//   ⑤ 回归：webfetch 仍可用（customTools 数组扩展）
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9349;
const LLM = 9491;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0, fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

const HOOKSIDE = path.join(os.tmpdir(), "p49-hook-side-effect.txt");

/* ---- mock LLM：多层工具循环 ---- */
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
		if (last?.role === "user" && textOf(last).includes("SUBAGENT-X")) {
			// 主会话：派发子任务（子代理 prompt 自带 REPORT-MARK）
			sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "subagent", arguments: "" } }] } }] });
			sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ prompt: "REPORT-MARK 调研目标：确认子代理链路", task: "调研" }) } }] } }] });
			sse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 30 } });
		} else if (last?.role === "user" && textOf(last).includes("REPORT-MARK")) {
			// 子代理轮：直接给结论（不调工具）
			sse(res, { choices: [{ delta: { content: "SUBAGENT_RESULT_OK 子代理结论：链路正常" } }] });
			sse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 60, completion_tokens: 20 } });
		} else if (last?.role === "user" && textOf(last).includes("RUN-BASH")) {
			sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: "c2", type: "function", function: { name: "bash", arguments: "" } }] } }] });
			sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: `echo hook-test > "${HOOKSIDE.replace(/\\/g, "/")}"` }) } }] } }] });
			sse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 80, completion_tokens: 20 } });
		} else if (last?.role === "user" && textOf(last).includes("FETCH-OK")) {
			sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: "c3", type: "function", function: { name: "webfetch", arguments: "" } }] } }] });
			sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ url: "https://example.com" }) } }] } }] });
			sse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 80, completion_tokens: 20 } });
		} else if (last?.role === "tool") {
			sse(res, { choices: [{ delta: { content: `工具结果：${textOf(last).slice(0, 400)} END49` } }] });
			sse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 50 } });
		} else {
			sse(res, { choices: [{ delta: { content: "收到。" } }] });
			sse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
llm.listen(LLM, "127.0.0.1");

/* ---- 沙箱 agentDir + hooks.json（bash after 副作用） ---- */
const agentDir = path.join(os.tmpdir(), "p49-agent");
fs.rmSync(agentDir, { recursive: true, force: true });
fs.mkdirSync(agentDir, { recursive: true });
const userModels = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "models.json"), "utf8"));
userModels.providers.zhipu.baseUrl = `http://127.0.0.1:${LLM}/v1`;
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(userModels));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "zhipu", defaultModel: "glm-5.2" })); // 默认链指向 mock 可用的 provider
const authSrc = path.join(os.homedir(), ".pi", "agent", "auth.json");
if (fs.existsSync(authSrc)) fs.copyFileSync(authSrc, path.join(agentDir, "auth.json"));
try { fs.rmSync(HOOKSIDE, { force: true }); } catch { /* 不存在 */ }
fs.writeFileSync(path.join(agentDir, "hooks.json"), JSON.stringify([
	{ on: "bash", phase: "after", command: `node -e "require('fs').writeFileSync(process.argv[1], 'hook-ran')" "${HOOKSIDE.replace(/\\/g, "/")}"`, timeoutMs: 10000 },
]));

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
spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), [ROOT, `--remote-debugging-port=${PORT}`], { cwd: ROOT, env: cleanEnv, detached: true, stdio: "ignore" }).unref();
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
	for (let i = 0; i < 90; i++) {
		await new Promise(r => setTimeout(r, 1000));
		if (document.querySelector("#btn-send")?.textContent !== "■") break;
	}
	const asst = [...document.querySelectorAll(".msg.assistant")].filter(m => m.textContent.includes("END49"));
	return asst.length ? asst.at(-1).textContent.slice(0, 800) : "";
})()`);

/* ① 子代理全链路 */
await ev(`sendText("SUBAGENT-X 派个调研任务")`);
const t1 = await lastText();
ok("① 子代理结论回主会话", t1.includes("SUBAGENT_RESULT_OK"), t1.slice(0, 160));
ok("① 工具卡「派发子任务」", await ev(`[...document.querySelectorAll(".tool .name")].some(n => /派发子任务|subagent/.test(n.textContent))`));

/* ③ hooks：bash after 副作用 */
await ev(`sendText("RUN-BASH 跑个命令")`);
const t3 = await lastText();
await sleep(1500);
ok("③ hooks after 副作用文件", fs.existsSync(HOOKSIDE) && fs.readFileSync(HOOKSIDE, "utf8").includes("hook-ran"), t3.slice(0, 100));

/* ⑤ webfetch 回归 */
await ev(`sendText("FETCH-OK 再抓一次")`);
const t5 = await lastText();
ok("⑤ webfetch 回归（数组扩展没坏）", t5.includes("Example Domain"), t5.slice(0, 120));

/* ④ auto-compact 开关 */
await ev(`openSettings()`);
await sleep(500);
ok("④ 设置页上下文管理卡", await ev(`!!document.querySelector("#ctx-card") && !!document.querySelector("#auto-compact-toggle")`));
const ac = await ev(`(async () => {
	const before = await window.openpi.getAutoCompact();
	await window.openpi.setAutoCompact(false);
	const after = await window.openpi.getAutoCompact();
	await window.openpi.setAutoCompact(before.enabled !== false);
	return { before: before.enabled, after: after.enabled };
})()`);
ok("④ 开关 RPC 往返", ac.before === true && ac.after === false, JSON.stringify(ac));

try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 已退出 */ }
await sleep(2000);
llm.close();
fs.rmSync(agentDir, { recursive: true, force: true });
try { fs.rmSync(HOOKSIDE, { force: true }); } catch { /* 已清 */ }
console.log(fails === 0 ? `✅ e2e-p49 ${total} 过 0 败` : `❌ e2e-p49 ${total - fails} 过 ${fails} 败`);
process.exit(fails === 0 ? 0 : 1);
