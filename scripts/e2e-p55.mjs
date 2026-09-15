// E2E P55：项目记忆（会话 A 写记忆 → 会话 B 注入生效）
//   ① 会话 A：memory_write 追加约定（未知写类工具走「操作审批」）
//   ② 新对话：system 注入含记忆内容（mock 捕获请求体关键词），Agent 能答出
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9356;
const LLM = 9496;
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
		const hasMemo = JSON.stringify(body).includes("P55-MEMO");
		const toolCall = (id, name, args) => {
			sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] } }] });
			sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] });
			sse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 30 } });
		};
		const finish = (text) => {
			sse(res, { choices: [{ delta: { content: text } }] });
			sse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 50 } });
		};
		if (last?.role === "user" && textOf(last).includes("P55-FLOW-A")) {
			toolCall("c1", "memory_write", { content: "P55-MEMO 本项目测试框架为 vitest" });
		} else if (last?.role === "tool" && !globalThis.p55a) {
			globalThis.p55a = true;
			if (process.env.P55_DUMP) console.error("[p55dump] write 结果:", textOf(last).slice(0, 200));
			finish(`A-OK ${textOf(last).slice(0, 200)} END55`);
		} else if (last?.role === "user" && textOf(last).includes("P55-FLOW-B")) {
			finish(`B-OK memo=${hasMemo ? 1 : 0} END55`);
		} else {
			finish("收到。");
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
llm.listen(LLM, "127.0.0.1");

/* ---- 前置：workspace git 就绪 + 清记忆残留 ---- */
const ws = path.join(os.homedir(), "openpi-workspace");
fs.mkdirSync(ws, { recursive: true });
const g = (...a) => execFileSync("git", a, { cwd: ws, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
if (!g("rev-parse", "--git-dir")) g("init", "-b", "main");
if (!g("rev-parse", "--verify", "-q", "HEAD")) {
	fs.writeFileSync(path.join(ws, ".gitkeep"), "");
	g("add", "-A");
	g("-c", "user.name=P55", "-c", "user.email=p55@e2e.local", "commit", "-m", "p55 baseline", "--no-verify");
}
fs.rmSync(path.join(ws, ".openpi"), { recursive: true, force: true });
console.log("[前置] workspace 就绪（记忆已清空）");

/* ---- 沙箱 agentDir ---- */
const agentDir = path.join(os.tmpdir(), "p55-agent");
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

/** 轮询「操作审批」弹窗（memory_write 属未知写类工具 → 通用审批），点「允许」 */
const approveGeneric = async () => {
	const clicked = [];
	let idle = 0;
	for (let i = 0; i < 240 && idle < 20; i++) {
		const r = await ev(`(() => {
			const m = [...document.querySelectorAll(".modal-mask")].find((x) => x.textContent.includes("操作审批"));
			if (!m) return "";
			const text = (m.querySelector(".ui-msg")?.textContent ?? "").slice(0, 80);
			m.querySelector(".ui-ok").click();
			return text;
		})()`);
		if (r) { clicked.push(r); idle = 0; } else idle++;
		await sleep(500);
	}
	return clicked;
};

/* 前置：切到 git 工作区会话 */
const wsSwitched = (await ev(`startSession(${JSON.stringify(ws)}).then(() => 1).catch((e) => "err:" + e.message)`)) === 1;
ok("⓪ 切到 git 工作区会话", wsSwitched);

/* ① 会话 A：写记忆（走审批） */
await ev(`(() => { sendText("P55-FLOW-A 记住这条项目约定"); return 1; })()`);
const approvals = await approveGeneric();
ok("① memory_write 弹「操作审批」", approvals.length >= 1 && approvals[0].includes("memory_write"), JSON.stringify(approvals).slice(0, 120));
const t1 = await lastText("END55");
ok("①a 写入成功（工具应答）", t1.includes("A-OK") && t1.includes("已写入"), t1.slice(0, 160));
const memoFile = path.join(ws, ".openpi", "MEMORY.md");
ok("①b 文件内容正确", fs.existsSync(memoFile) && fs.readFileSync(memoFile, "utf8").includes("P55-MEMO"), "");

/* ② 新对话（跨会话）：注入生效 */
await ev("newSession().then(() => 1).catch(() => 0)");
await sleep(2000);
await ev(`(() => { sendText("P55-FLOW-B 项目的测试框架是什么"); return 1; })()`);
const t2 = await lastText("END55");
ok("② 新会话 system 注入记忆内容", t2.includes("B-OK") && t2.includes("memo=1"), t2.slice(0, 160));

try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 已退出 */ }
await sleep(2000);
llm.close();
fs.rmSync(agentDir, { recursive: true, force: true });
fs.rmSync(path.join(ws, ".openpi"), { recursive: true, force: true });
console.log(fails === 0 ? `✅ e2e-p55 ${total} 过 0 败` : `❌ e2e-p55 ${total - fails} 过 ${fails} 败`);
process.exit(fails === 0 ? 0 : 1);
