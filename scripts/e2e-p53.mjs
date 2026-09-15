// E2E P53：git 检查点（写前自动快照 + git_status/git_diff/git_rollback）
//   ① auto-edit 档 write 直通 → 自动建检查点（git_status 可见）
//   ② 二轮改动后 git_diff 对照快照有差异
//   ③ git_rollback 走「操作审批」弹窗 → 回滚后文件恢复快照版本
//   ④ 非 git 注入豁免：默认 workspace 有基线（e2e 前置保证），提示词注入生效由①间接验证
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9353;
const LLM = 9493;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0, fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

/* ---- mock LLM：git 工具循环 ---- */
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
		const wsPath = path.join(os.homedir(), "openpi-workspace");
		if (last?.role === "user" && textOf(last).includes("P53-FLOW-A")) {
			toolCall("c1", "write", { path: path.join(wsPath, "p53-ck.txt"), content: "CHECK-A" });
		} else if (last?.role === "tool" && !globalThis.p53a) {
			globalThis.p53a = true;
			toolCall("c2", "git_status", {});
		} else if (last?.role === "tool" && !globalThis.p53aDone) {
			globalThis.p53aDone = true;
			if (process.env.P53_DUMP) console.error("[p53dump] git_status 结果:", textOf(last).slice(0, 400));
			finish(`A-OK ${textOf(last).slice(0, 400)} END53`);
		} else if (last?.role === "user" && textOf(last).includes("P53-FLOW-B")) {
			toolCall("c3", "write", { path: path.join(wsPath, "p53-ck.txt"), content: "CHECK-B" });
		} else if (last?.role === "tool" && !globalThis.p53b) {
			globalThis.p53b = true;
			finish(`B-DONE END53`);
		} else if (last?.role === "user" && textOf(last).includes("P53-FLOW-C")) {
			toolCall("c4", "git_rollback", {});
		} else if (last?.role === "tool" && !globalThis.p53c) {
			globalThis.p53c = true;
			if (process.env.P53_DUMP) console.error("[p53dump] rollback 结果:", textOf(last).slice(0, 300));
			finish(`C-OK ${textOf(last).slice(0, 200)} END53`);
		} else {
			finish("收到。");
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
llm.listen(LLM, "127.0.0.1");

/* ---- 前置：默认 workspace 必须是 git 仓库（P53 生效前提） ---- */
const ws = path.join(os.homedir(), "openpi-workspace");
fs.mkdirSync(ws, { recursive: true });
const g = (...a) => execFileSync("git", a, { cwd: ws, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
if (!g("rev-parse", "--git-dir")) {
	g("init", "-b", "main");
}
if (!g("rev-parse", "--verify", "-q", "HEAD")) {
	fs.writeFileSync(path.join(ws, ".gitkeep"), "");
	g("add", "-A");
	g("-c", "user.name=P53", "-c", "user.email=p53@e2e.local", "commit", "-m", "p53 baseline", "--no-verify");
}
fs.rmSync(path.join(ws, "p53-ck.txt"), { force: true }); // 清测试残留
console.log("[前置] workspace git 就绪");

/* ---- 沙箱 agentDir ---- */
const agentDir = path.join(os.tmpdir(), "p53-agent");
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
	const asst = [...document.querySelectorAll(".msg.assistant")].filter(m => m.textContent.includes("END53"));
	if (!asst.length) return "[EMPTY] btn=" + btn() + " asst气泡=" + document.querySelectorAll(".msg.assistant").length;
	return asst.at(-1).textContent.slice(0, 800);
})()`);

/** 轮询「操作审批」弹窗（git_rollback 属未知写类工具 → 通用审批），点「允许」 */
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

/* ① 前置：驱动渲染层切到 git 工作区（boot 默认任务模式 workspace=null，检查点不可用） */
const wsSwitched = (await ev(`startSession(${JSON.stringify(ws)}).then(() => 1).catch((e) => "err:" + e.message)`)) === 1;
ok("⓪ 切到 git 工作区会话", wsSwitched);

/* ① write + 自动检查点 + git_status */
await ev(`(() => { sendText("P53-FLOW-A 创建测试文件并查看检查点"); return 1; })()`);
const t1 = await lastText();
ok("① write 自动建检查点（git_status 可见）", t1.includes("A-OK") && t1.includes("openpi:checkpoint"), t1.slice(0, 160));

/* ② 改动（>30s 节流窗 → 新快照） */
console.log("[等待 31s 让节流窗过期，确保②建立新快照]");
await sleep(31_000);
await ev(`(() => { sendText("P53-FLOW-B 修改文件内容"); return 1; })()`);
const t2 = await lastText();
ok("② 二轮改动放行（无审批 auto-edit）", t2.includes("B-DONE"), t2.slice(0, 120));
const contentB = fs.readFileSync(path.join(ws, "p53-ck.txt"), "utf8");
ok("②a 文件已被改为 CHECK-B", contentB.trim() === "CHECK-B", JSON.stringify(contentB));

/* ③ git_rollback 审批 + 回滚恢复 */
await ev(`(() => { sendText("P53-FLOW-C 回滚到最近检查点"); return 1; })()`);
const approvals = await approveGeneric();
ok("③ git_rollback 弹「操作审批」", approvals.length >= 1 && approvals[0].includes("git_rollback"), JSON.stringify(approvals).slice(0, 120));
const t3 = await lastText();
ok("③a 回滚成功（工具应答 ok）", t3.includes("C-OK"), t3.slice(0, 160));
const contentC = fs.readFileSync(path.join(ws, "p53-ck.txt"), "utf8");
ok("③b 文件恢复为 CHECK-A（写前快照语义）", contentC.trim() === "CHECK-A", JSON.stringify(contentC));
fs.rmSync(path.join(ws, "p53-ck.txt"), { force: true });

try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 已退出 */ }
await sleep(2000);
llm.close();
fs.rmSync(agentDir, { recursive: true, force: true });
console.log(fails === 0 ? `✅ e2e-p53 ${total} 过 0 败` : `❌ e2e-p53 ${total - fails} 过 ${fails} 败`);
process.exit(fails === 0 ? 0 : 1);
