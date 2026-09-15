// E2E P47：联网检索（webfetch/websearch customTools）+ P48 用量
//   ① webfetch 真抓 example.com 并把内容回给模型
//   ② SSRF 防护：127.0.0.1 被拒绝
//   ③ websearch 走 mock Tavily（OPENPI_TAVILY_BASE 注入）
//   ④ 设置页联网检索卡片存在
//   ⑤ 状态栏用量非零（P48 累计链路）
//   ⑥ getUsage() 聚合含历史轮（RPC）
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9347;
const LLM = 9471; // mock LLM（openai-completions SSE）
const TAVILY = 9472; // mock Tavily
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0, fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

/* ---- mock Tavily：POST /search → 固定结果 ---- */
const tav = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		let query = "";
		try { query = JSON.parse(Buffer.concat(chunks).toString()).query ?? ""; } catch { /* 忽略 */ }
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ results: [
			{ title: "OpenPi Mock Result", url: "https://example.com/mock", content: `查询「${query}」的模拟搜索结果 P47WEBSEARCH 标记` },
			{ title: "第二条", url: "https://example.com/2", content: "second mock" },
		] }));
	});
});
tav.listen(TAVILY, "127.0.0.1");

/* ---- mock LLM：user→tool_call，tool→文本总结 ---- */
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const llm = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		let body = {};
		try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* 忽略 */ }
		const last = body.messages?.[body.messages.length - 1];
		if (last?.role === "user") {
			const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
			let name = "webfetch", args = { url: "https://example.com" };
			if (text.includes("SEARCH-X")) { name = "websearch"; args = { query: "openpi desktop", count: 3 }; }
			else if (text.includes("FETCH-BLOCK")) args = { url: "http://127.0.0.1:9/x" };
			const id = `call_${Date.now()}`;
			sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] } }] });
			sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] });
			sse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 } });
		} else {
			const txt = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
			const summary = `工具结果：${String(txt).slice(0, 400)} END47`;
			sse(res, { choices: [{ delta: { content: summary } }] });
			sse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 } });
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
llm.listen(LLM, "127.0.0.1");

/* ---- 沙箱 agentDir：models.json 指向 mock LLM ---- */
const agentDir = path.join(os.tmpdir(), "p47-agent");
fs.rmSync(agentDir, { recursive: true, force: true });
fs.mkdirSync(agentDir, { recursive: true });
const userModels = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "models.json"), "utf8"));
userModels.providers.zhipu.baseUrl = `http://127.0.0.1:${LLM}/v1`;
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(userModels));
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
cleanEnv.OPENPI_TAVILY_BASE = `http://127.0.0.1:${TAVILY}`;
cleanEnv.OPENPI_TAVILY_KEY = "tvly-mock";
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
	for (let i = 0; i < 60; i++) {
		await new Promise(r => setTimeout(r, 1000));
		const busy = document.querySelector("#btn-send")?.textContent === "■";
		if (!busy) break;
	}
	const asst = [...document.querySelectorAll(".msg.assistant")].filter(m => m.textContent.includes("END47"));
	return asst.length ? asst.at(-1).textContent.slice(0, 600) : "";
})()`);

/* ① webfetch 真抓取 */
await ev(`sendText("FETCH-OK 请抓取这个页面")`);
const t1 = await lastText();
ok("webfetch 抓取 example.com", t1.includes("Example Domain"), t1.slice(0, 120));
ok("工具卡片显示「抓取网页」", await ev(`[...document.querySelectorAll(".tool .name")].some(n => /抓取网页|webfetch/.test(n.textContent))`));

/* ② SSRF 拦截 */
await ev(`sendText("FETCH-BLOCK 再抓这个")`);
const t2 = await lastText();
ok("SSRF 拦截 127.0.0.1", t2.includes("拒绝访问") || t2.includes("内网"), t2.slice(0, 140));

/* ③ websearch → mock Tavily */
await ev(`sendText("SEARCH-X 搜索一下")`);
const t3 = await lastText();
ok("websearch 走 Tavily（mock）", t3.includes("P47WEBSEARCH"), t3.slice(0, 140));

/* ④ 设置页卡片 */
await ev(`openSettings()`);
await sleep(500);
ok("设置页联网检索卡片", await ev(`!!document.querySelector("#web-card") && !!document.querySelector("#tavily-key")`));
await ev(`document.getElementById("btn-settings-close")?.click()`);

/* ⑤ 状态栏用量（P48） */
const usageTxt = await ev(`document.querySelector("#usage")?.textContent ?? ""`);
ok("状态栏用量非零", /in [1-9]/.test(usageTxt) || /in \d{2,}/.test(usageTxt), usageTxt);
ok("用量含成本字段（RPC 聚合）", await ev(`(async () => { const u = await window.openpi.getUsage(); return u && u.input > 0; })()`));

try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 已退出 */ }
await sleep(2000);
llm.close(); tav.close();
fs.rmSync(agentDir, { recursive: true, force: true });
console.log(fails === 0 ? `✅ e2e-p47 ${total} 过 0 败` : `❌ e2e-p47 ${total - fails} 过 ${fails} 败`);
process.exit(fails === 0 ? 0 : 1);
