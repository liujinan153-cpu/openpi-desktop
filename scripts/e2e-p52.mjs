// E2E P52：内置浏览器控制
//   ① browser_open：懒启动受控浏览器 → 打开测试表单页 → 返回带 [ref] 的快照
//   ② 审批：auto-edit 档位下 browser_type 弹「浏览器写操作」确认
//   ③ browser_type 提交链路：输入 → 回车 → 导航到结果页（提交成功 P52-NAME）
//   ④ browser_tabs list
//   ⑤ 回归：webfetch 仍可用（customTools 数组扩展没坏）
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9352;
const LLM = 9492;
const SITE = 9530;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0, fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

/* ---- 本地测试站点：表单页 + 结果页 ---- */
const site = http.createServer((req, res) => {
	const u = new URL(req.url, "http://x");
	if (u.pathname === "/form") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(`<!doctype html><html><head><title>P52 测试表单页</title></head><body>
			<h1>OpenPi P52 浏览器控制测试</h1>
			<input id="name" placeholder="姓名" onkeydown="if(event.key===&apos;Enter&apos;)document.getElementById(&apos;go&apos;).click()" />
			<select id="city"><option value="bj">北京</option><option value="sh">上海</option></select>
			<button id="go" onclick="location.href='/done?name='+encodeURIComponent(document.getElementById('name').value)+'&city='+document.getElementById('city').value">提交</button>
		</body></html>`);
	} else if (u.pathname === "/done") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(`<!doctype html><html><head><title>P52 结果页</title></head><body><h1>提交成功 ${u.searchParams.get("name")}（${u.searchParams.get("city")}）</h1></body></html>`);
	} else { res.writeHead(404); res.end("404"); }
});
site.listen(SITE, "127.0.0.1");

/* ---- mock LLM：浏览器工具循环 ---- */
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const llm = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		let body = {};
		try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* 忽略 */ }
		const last0 = body.messages?.[body.messages.length - 1];
		if (process.env.P52_DUMP) console.error(`[p52dump] 请求: last.role=${last0?.role} text=${String(typeof last0?.content === "string" ? last0.content : JSON.stringify(last0?.content ?? "")).slice(0, 60)}`);
		if (process.env.P52_DUMP) {
			const tools = (body.messages ?? []).filter((m) => m.role === "assistant").flatMap((m) => (m.tool_calls ?? []).map((tc) => tc.function?.name + "(" + String(tc.function?.arguments).slice(0, 60) + ")"));
			const lastTool = (body.messages ?? []).filter((m) => m.role === "tool").at(-1);
			if (tools.length) console.error("[dump] 累计调用:", tools.join(" >> "), "| 最后一tool结果:", String(lastTool ? JSON.stringify(lastTool.content ?? "").slice(0, 80) : ""));
		}
		const last = body.messages?.[body.messages.length - 1];
		const textOf = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
		globalThis.openSnap = globalThis.openSnap ?? "";
		const toolCall = (id, name, args) => {
			sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] } }] });
			sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] });
			sse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 30 } });
		};
		if (last?.role === "user" && textOf(last).includes("BROWSE-FLOW")) {
			toolCall("c1", "browser_open", { url: `http://127.0.0.1:${SITE}/form` });
		} else if (last?.role === "tool" && textOf(last).includes("P52 测试表单页")) {
				globalThis.openSnap = textOf(last);
			// 从快照提取第一个 input 的 ref，输入并回车提交
			const m = textOf(last).match(/\[([a-z0-9]+)\] <input/);
			if (!m) {
				sse(res, { choices: [{ delta: { content: `FLOW-FAIL 快照中没有 input：${textOf(last).slice(0, 200)}` } }] });
				sse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 30 } });
			} else toolCall("c2", "browser_type", { ref: m[1], text: "P52-NAME", submit: true });
		} else if (last?.role === "tool" && textOf(last).includes("提交成功")) {
			sse(res, { choices: [{ delta: { content: `FLOW-OK [snap] ${(globalThis.openSnap ?? "").slice(0, 300)} [done] ${textOf(last).slice(0, 300)} END52` } }] });
			sse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 50 } });
		} else if (last?.role === "user" && textOf(last).includes("BROWSE-TABS")) {
			toolCall("c3", "browser_tabs", { action: "list" });
		} else if (last?.role === "tool" && textOf(last).includes("END52") === false && textOf(last).includes("[0]")) {
			sse(res, { choices: [{ delta: { content: `TABS-OK ${textOf(last).slice(0, 200)} END52` } }] });
			sse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 30 } });
		} else if (last?.role === "user" && textOf(last).includes("FETCH-OK")) {
			toolCall("c4", "webfetch", { url: "https://example.com" });
		} else if (last?.role === "tool") {
			sse(res, { choices: [{ delta: { content: `工具结果：${textOf(last).slice(0, 300)} END52` } }] });
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

/* ---- 沙箱 agentDir（默认档位 auto-edit → 浏览器写类应弹审批） ---- */
const agentDir = path.join(os.tmpdir(), "p52-agent");
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
		out.split("\n").filter((l) => (l.includes(`:${PORT}`) || l.includes(`:${SITE}`)) && l.includes("LISTENING"))
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
	for (let i = 0; i < 20; i++) { if (btn() === "■") break; await new Promise(r => setTimeout(r, 500)); } // 等流式开始
	for (let i = 0; i < 240; i++) { await new Promise(r => setTimeout(r, 500)); if (btn() !== "■") break; } // 等流式结束
	const asst = [...document.querySelectorAll(".msg.assistant")].filter(m => m.textContent.includes("END52"));
	if (!asst.length) return "[EMPTY] btn=" + btn() + " asst气泡=" + document.querySelectorAll(".msg.assistant").length;
	return asst.at(-1).textContent.slice(0, 800);
})()`);

/** 轮询审批弹窗（浏览器写操作确认），断言文案并点「允许」 */
const approveBrowserWrite = async () => {
	const clicked = [];
	let idle = 0;
	const t0 = Date.now();
	for (let i = 0; i < 240 && idle < 20; i++) {
		const r = await ev(`(() => {
			const m = [...document.querySelectorAll(".modal-mask")].find((x) => x.textContent.includes("浏览器写操作"));
			if (!m) return "";
			const text = m.querySelector(".modal-head span").textContent + " | " + (m.querySelector(".ui-msg")?.textContent ?? "").slice(0, 100);
			m.querySelector(".ui-ok").click();
			return text;
		})()`);
		if (i % 20 === 0 || r) console.log(`[approve] i=${i} 耗时=${Date.now() - t0}ms r=${r ? "HIT" : "无"}`);
		if (r) { clicked.push(r); idle = 0; } else idle++;
		await sleep(500);
	}
	return { clicked, masks: await ev(`document.querySelectorAll(".modal-mask").length`).catch(() => -1) };
};

/* ①③ browser_open + 审批 + browser_type 提交链路 */
await ev(`(() => { sendText("BROWSE-FLOW 打开测试页"); return 1; })()`);
const approval = await approveBrowserWrite();
ok("② 浏览器写类弹审批确认", approval.clicked?.length >= 1 && approval.clicked[0].includes("browser_type"), JSON.stringify(approval).slice(0, 160));
const t1 = await lastText();
ok("① browser_open 快照（含标题与 ref）", t1.includes("P52 测试表单页") && /\[[a-z0-9]+\]/.test(t1), t1.slice(0, 140));
ok("③ browser_type 提交 → 结果页", t1.includes("提交成功") && t1.includes("P52-NAME"), t1.slice(0, 200));

/* ④ browser_tabs */
await ev(`(() => { sendText("BROWSE-TABS 列出标签页"); return 1; })()`);
const approvalTabs = await approveBrowserWrite();
ok("④a browser_tabs 弹审批", approvalTabs.clicked?.length >= 1 && approvalTabs.clicked[0].includes("browser_tabs"), JSON.stringify(approvalTabs).slice(0, 160));
const t4 = await lastText();
ok("④ browser_tabs list", t4.includes("TABS-OK") && /\[0\]/.test(t4), t4.slice(0, 120));

/* ⑤ webfetch 回归 */
await ev(`(() => { sendText("FETCH-OK 再抓一次"); return 1; })()`);
const t5 = await lastText();
ok("⑤ webfetch 回归（数组扩展没坏）", t5.includes("Example Domain"), t5.slice(0, 120));

try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 已退出 */ }
await sleep(2000);
llm.close();
site.close();
fs.rmSync(agentDir, { recursive: true, force: true });
// 清受控浏览器（e2e 拉起的 chromium）：按 user-data-dir 特征杀
try {
	const out = execFileSync("wmic", ["process", "where", "commandline like '%browser-profile%'", "get", "processid"], { encoding: "utf8" });
	for (const m of out.matchAll(/(\d+)\s*$/gm)) execFileSync("taskkill", ["/PID", m[1], "/T", "/F"], { stdio: "ignore" });
} catch { /* 无残留 */ }
console.log(fails === 0 ? `✅ e2e-p52 ${total} 过 0 败` : `❌ e2e-p52 ${total - fails} 过 ${fails} 败`);
process.exit(fails === 0 ? 0 : 1);
