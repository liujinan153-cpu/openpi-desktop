// E2E P59：CUA 强化——UIA 控件树 + 按名点击（点控件代替猜坐标）
//   ① AI 列窗口 → computer_elements 读靶子窗口控件树（只读直通）
//   ② computer_click 按「控件名」点击输入框（走审批）→ computer_type 输入
//   ③ CDP 直读输入框值 = P59-OK（按名点击真落地铁证）
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9359;
const LLM = 9499;
const HELPER_PORT = 9659;
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
		// 状态机：列窗口 → elements → 按名点击 → 输入 → finish
		if (last?.role === "user" && textOf(last).includes("P59-FLOW-A")) {
			toolCall("c1", "computer_windows", {});
		} else if (last?.role === "tool" && !globalThis.p59win) {
			globalThis.p59win = true;
			const wm = textOf(last).match(/pid=(\d+)\s+electron\s+「P56-TARGET」/);
			if (!wm) { finish("FAIL0 找不到靶子窗口 END59"); return; }
			globalThis.p59pid = Number(wm[1]);
			toolCall("c2", "computer_elements", { pid: globalThis.p59pid });
		} else if (last?.role === "tool" && !globalThis.p59els) {
			globalThis.p59els = true;
			globalThis.p59elsText = textOf(last);
			const em = globalThis.p59elsText.match(/Edit「P59 输入框」 @ \((\d+),(\d+)\)/);
			if (!em) { finish("FAIL0 控件树未暴露输入框 END59"); return; }
			globalThis.p59xy = [Number(em[1]), Number(em[2])];
			toolCall("c3", "computer_click", { x: globalThis.p59xy[0], y: globalThis.p59xy[1] });
		} else if (last?.role === "tool" && !globalThis.p59clicked) {
			globalThis.p59clicked = true;
			globalThis.p59clickText = textOf(last);
			if (process.env.P59_DUMP) console.error("[p59dump] click:", textOf(last).slice(0, 200));
			// 审批弹窗会抢前台：输入前先 activate 靶子窗口
			toolCall("c4", "computer_activate", { pid: globalThis.p59pid });
		} else if (last?.role === "tool" && !globalThis.p59activated) {
			globalThis.p59activated = true;
			toolCall("c5", "computer_type", { text: "P59-OK" });
		} else if (last?.role === "tool" && !globalThis.p59typed) {
			globalThis.p59typed = true;
			finish(`OK9 els=${(globalThis.p59elsText || "").includes("P59 输入框") ? 1 : 0} click=${(globalThis.p59clickText || "").includes("clicked") ? 1 : 0} END59`);
		} else {
			finish("收到。");
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
llm.listen(LLM, "127.0.0.1");

/* ---- 前置：helper 靶子窗口（input 带 aria-label → UIA Name） ---- */
const helperProcRef = spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"),
	[path.join(ROOT, "scripts", "e2e-p56-helper.cjs"), `--remote-debugging-port=${HELPER_PORT}`],
	{ detached: false, stdio: "ignore" });
let helperReady = false;
for (let i = 0; i < 20; i++) {
	await sleep(1000);
	try { const r = await fetch(`http://127.0.0.1:${HELPER_PORT}/json/version`); if (r.ok) { helperReady = true; break; } } catch { /* 未就绪 */ }
}
if (!helperReady) { console.error("❌ 前置失败：helper 未就绪"); llm.close(); process.exit(1); }
console.log("[前置] 靶子窗口就绪");

/* ---- 沙箱 agentDir ---- */
const ws = path.join(os.homedir(), "openpi-workspace");
fs.mkdirSync(ws, { recursive: true });
const agentDir = path.join(os.tmpdir(), "p59-agent");
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

/** 轮询审批弹窗（按名点击/输入属写类），点「允许」 */
const approveGeneric = async () => {
	const clicked = [];
	let idle = 0;
	for (let i = 0; i < 240 && idle < 20; i++) {
		const r = await ev(`(() => {
			const m = [...document.querySelectorAll(".modal-mask")].find((x) => x.textContent.includes("操作审批"));
			if (!m) return "";
			const ok = [...m.querySelectorAll("button")].find((b) => /允许|批准|确定/.test(b.textContent));
			if (ok) { ok.click(); return "clicked"; }
			return "modal";
		})()`);
		if (r === "clicked") { clicked.push(1); idle = 0; await sleep(800); }
		else if (r === "modal") { idle = 0; await sleep(500); }
		else { idle++; await sleep(500); }
	}
	return clicked;
};

/* ⓪ 切到工作区会话 */
await ev(`startSession(${JSON.stringify(ws)})`);
await sleep(1500);
ok("⓪ 切到工作区会话", true);

/* ① 全链路：列窗口 → 控件树 → 按名点击(审批) → 输入(审批) */
await ev(`(() => { sendText("P59-FLOW-A 用控件树定位靶子窗口的输入框，点它并输入文字"); return 1; })()`);
const approvals = await approveGeneric();
ok("① 按名点击/输入走「操作审批」", approvals.length >= 2, JSON.stringify(approvals).slice(0, 100));
const t1 = await lastText("OK9");
ok("② elements 控件树暴露输入框（按名）", t1.includes("els=1"), t1.slice(0, 120));
ok("③ 按名点击成功", t1.includes("click=1"), t1.slice(0, 120));
if (process.env.P59_DUMP) console.log("[p59dump] t1:", t1.slice(0, 300));

/* ④ 铁证：CDP 直读靶子输入框内容 */
let helperVal = null;
try {
	const helperTabs = await CDP.List({ port: HELPER_PORT });
	const hp = helperTabs.find((t) => t.type === "page");
	const hc = await CDP({ target: hp.webSocketDebuggerUrl });
	const hr = await hc.Runtime.evaluate({ expression: "document.getElementById(\"t\").value", returnByValue: true });
	helperVal = hr.result.value;
	await hc.close();
} catch (e) { helperVal = "CDP-ERR:" + e.message.slice(0, 80); }
ok("④ 按名点击后输入真落地（input=P59-OK）", helperVal === "P59-OK", JSON.stringify(helperVal));

/* 清理 */
try { client.close(); } catch { /* 忽略 */ }
try { helperProcRef.kill(); } catch { /* 已退出 */ }
try { execFileSync("taskkill", ["/PID", String(helperProcRef.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* 已退出 */ }
try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 已退出 */ }
await sleep(1500);
llm.close();
console.log(fails === 0 ? `✅ e2e-p59 ${total} 过 0 败` : `❌ e2e-p59 ${total - fails} 过 ${fails} 败`);
process.exit(fails === 0 ? 0 : 1);
