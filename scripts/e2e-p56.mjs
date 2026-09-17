// E2E P56：OS 级 computer-use（记事本全链路）
//   ① computer_windows（只读直通）找到 notepad
//   ② computer_activate（写类→审批）聚焦 → computer_type（写类→审批）输入 P56-OK
//   ③ computer_windows 断言标题含 P56-OK → computer_screenshot（只读）PNG 落盘
//   ④ 审计日志有记录
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

/* ---- mock LLM：电脑操作循环 ---- */
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
		const winList = last?.role === "tool" ? textOf(last) : "";
		if (last?.role === "user" && textOf(last).includes("P56-FLOW-A")) {
			toolCall("c1", "computer_windows", {});
		} else if (last?.role === "tool" && !globalThis.p56listed) {
			if (process.env.P56_DUMP) console.error("[p56dump] winList:", winList.slice(0, 2000));
			globalThis.p56listed = true;
			const wm = winList.match(/pid=(\d+)\s+electron\s+「P56-TARGET」/);
			if (!wm) { finish(`FAIL1 找不到靶子窗口: ${winList.slice(0, 1200)} END56`); return; }
			toolCall("c2", "computer_activate", { pid: Number(wm[1]) });
		} else if (last?.role === "tool" && !globalThis.p56act) {
			globalThis.p56act = true;
			toolCall("c3", "computer_type", { text: "P56-OK" });
		} else if (last?.role === "tool" && !globalThis.p56typed) {
			globalThis.p56typed = true;
			toolCall("c4", "computer_windows", {});
		} else if (last?.role === "tool" && !globalThis.p56vlist) {
			globalThis.p56vlist = true;
			globalThis.p56titleOk = winList.includes("P56-OK");
			toolCall("c5", "computer_screenshot", {});
		} else if (last?.role === "tool" && !globalThis.p56shot) {
			globalThis.p56shot = true;
			finish(`OK6 win=${globalThis.p56titleOk ? 1 : 0} shot=${winList.slice(0, 120)} END56`);
		} else {
			finish("收到。");
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
llm.listen(LLM, "127.0.0.1");

/* ---- 前置：workspace git 就绪 + 启动记事本 ---- */
const ws = path.join(os.homedir(), "openpi-workspace");
fs.mkdirSync(ws, { recursive: true });
const g = (...a) => execFileSync("git", a, { cwd: ws, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
if (!g("rev-parse", "--git-dir")) g("init", "-b", "main");
if (!g("rev-parse", "--verify", "-q", "HEAD")) {
	fs.writeFileSync(path.join(ws, ".gitkeep"), "");
	g("add", "-A");
	g("-c", "user.name=P56", "-c", "user.email=p56@e2e.local", "commit", "-m", "p56 baseline", "--no-verify");
}
/* 前置：启动独立 helper 靶子窗口（title=P56-TARGET，输入框自动聚焦） */
const HELPER_PORT = 9649;
const helperEnv = { ...process.env }; // pi Desktop 内起 bash 时会继承 ELECTRON_RUN_AS_NODE=1 → helper 变纯 node 秒退（P70 全量抓到）
delete helperEnv.ELECTRON_RUN_AS_NODE;
const helperProcRef = spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"),
	[path.join(ROOT, "scripts", "e2e-p56-helper.cjs"), `--remote-debugging-port=${HELPER_PORT}`],
	{ detached: false, stdio: "ignore", env: helperEnv });
let helperReady = false;
for (let i = 0; i < 20; i++) {
	await sleep(1000);
	try { const r = await fetch(`http://127.0.0.1:${HELPER_PORT}/json/version`); if (r.ok) { helperReady = true; break; } } catch { /* 未就绪 */ }
}
if (!helperReady) { console.error("❌ 前置失败：helper 未就绪"); llm.close(); process.exit(1); }
// 取靶子窗口 title 确认（electron BrowserWindow title）
const helperTabs = await CDP.List({ port: HELPER_PORT });
const helperPage = helperTabs.find((t) => t.type === "page" && t.title === "P56-TARGET");
if (!helperPage) { console.error("❌ 前置失败：未找到 P56-TARGET 页面"); llm.close(); process.exit(1); }

console.log("[前置] workspace 就绪 + 靶子窗口就绪");

/* ---- 沙箱 agentDir ---- */
const agentDir = path.join(os.tmpdir(), "p56-agent");
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
try { const o = execFileSync("powershell", ["-NoProfile","-Command","Get-Process electron -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"], { encoding: "utf8" }); console.log("[p56dbg] electrons:", o.trim().split(/\s+/).join(",")); } catch { console.log("[p56dbg] no electron"); }

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
	const asst = [...document.querySelectorAll(".msg.assistant")].filter(m => m.textContent.includes("END56"));
	if (!asst.length) return "[EMPTY] btn=" + btn() + " asst气泡=" + document.querySelectorAll(".msg.assistant").length;
	return asst.at(-1).textContent.slice(0, 800);
})()`);

/** 轮询「操作审批」弹窗（写类工具 → 通用审批），点「允许」 */
const approveGeneric = async () => {
	const clicked = [];
	let idle = 0;
	for (let i = 0; i < 360 && idle < 20; i++) {
		const r = await ev(`(() => {
			const m = [...document.querySelectorAll(".modal-mask")].find((x) => x.textContent.includes("操作审批"));
			if (!m) return "";
			const text = (m.querySelector(".ui-msg")?.textContent ?? "").slice(0, 60);
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

/* ① 全链路：列窗口→激活(审批)→输入(审批)→验证标题→截图 */
await ev(`(() => { sendText("P56-FLOW-A 在记事本里输入文字并截图验证"); return 1; })()`);
const approvals = await approveGeneric();
ok("① activate/type 走「操作审批」", approvals.length >= 2, JSON.stringify(approvals).slice(0, 140));
const t1 = await lastText();
/* 铁证：CDP 直读靶子窗口输入框内容 */
let helperVal = null;
try {
	const helperTabsNow = await CDP.List({ port: HELPER_PORT });
	const helperPageNow = helperTabsNow.find((t) => t.type === "page");
	const hc = await CDP({ target: helperPageNow.webSocketDebuggerUrl });
	await hc.Runtime.enable();
	const hr = await hc.Runtime.evaluate({ expression: "document.getElementById(\"t\").value", returnByValue: true });
	helperVal = hr.result.value;
	await hc.close();
} catch (e) { helperVal = "CDP-ERR:" + e.message.slice(0, 80); }
ok("② 输入真落地（靶子输入框=P56-OK）", helperVal === "P56-OK", JSON.stringify(helperVal));
const shotPath = (t1.match(/已截图：([^（\s]+)/) || [])[1];
ok("③ screenshot PNG 落盘", !!shotPath && fs.existsSync(shotPath) && fs.statSync(shotPath).size > 10000, String(shotPath));

/* ④ 审计日志 */
await sleep(1000);
const auditLog = path.join(os.homedir(), ".pi", "agent", "computer-audit.log");
const auditTxt = fs.existsSync(auditLog) ? fs.readFileSync(auditLog, "utf8") : "";
ok("④ 审计日志记录了电脑操作", auditTxt.includes("daemon_wins") && auditTxt.includes("daemon_paste"), auditTxt.split("\n").length + " 行");

try { helperProcRef.kill(); } catch { /* 已退出 */ }
try { execFileSync("taskkill", ["/PID", String(helperProcRef.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* 已退出 */ }
try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 已退出 */ }
await sleep(2000);
llm.close();
fs.rmSync(agentDir, { recursive: true, force: true });
console.log(fails === 0 ? `✅ e2e-p56 ${total} 过 0 败` : `❌ e2e-p56 ${total - fails} 过 ${fails} 败`);
process.exit(fails === 0 ? 0 : 1);
