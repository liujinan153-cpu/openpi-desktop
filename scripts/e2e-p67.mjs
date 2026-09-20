// E2E P67：UI 第二波——minimap 对话轨道 + 设置全局搜索
//   ① 长回复使 chat 可滚动 → minimap 显示且 segments ≥ 3
//   ② 视口指示器（minimap-vp）可见
//   ③ 点击轨道下半部 → chat.scrollTop 跳转生效
//   ④ 设置搜索 "mcp" → 结果弹层 → 点击跳 tools tab（P73 第三批迁出）+ mcp-card flash 高亮
//   ⑤ 设置搜索 "密钥" + Enter → 跳 keys tab
//   ⑥ 搜索无命中 → 空态提示
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9372;
const LLM = 9512;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0, fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

/* ---- mock LLM：P67-LONG → 超长回复（撑出滚动条）；其余短回复 ---- */
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
		let reply = "收到。P67";
		if (last?.role === "user" && textOf(last).includes("P67-LONG")) {
			const para = "这是一段用于撑出滚动条的长文本，讲述一个漫长的故事，包含很多行与很多段落。";
			reply = Array.from({ length: 30 }, (_, i) => `第${i + 1}段：${para}`).join("\n\n");
		}
		sse(res, { choices: [{ delta: { content: reply } }] });
		sse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 500 } });
		res.write("data: [DONE]\n\n"); // #118：必须 [DONE]+end
		res.end();
	});
});
await new Promise((r) => llm.listen(LLM, "127.0.0.1", r));

/* ---- ev ---- */
let client;
const ev = async (expr) => {
	const { Runtime } = client;
	const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "ev error");
	return r.result.value;
};
const waitSettled = async () => {
	for (let i = 0; i < 60; i++) {
		await sleep(500);
		if (await ev(`(window.__evts ?? []).includes("agent_settled")`)) { await sleep(800); return; }
	}
	throw new Error("agent_settled 超时");
};

/* ---- 前置：独立 workspace ---- */
const ws = path.join(os.tmpdir(), "p67-ws-" + Date.now());
fs.mkdirSync(ws, { recursive: true });
const agentDir = path.join(os.tmpdir(), "p67-agent");
fs.rmSync(agentDir, { recursive: true, force: true });
fs.mkdirSync(agentDir, { recursive: true });
const userModels = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "models.json"), "utf8"));
userModels.providers.zhipu.baseUrl = `http://127.0.0.1:${LLM}/v1`;
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(userModels));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "zhipu", defaultModel: "glm-5.2" }));
const authSrc = path.join(os.homedir(), ".pi", "agent", "auth.json");
if (fs.existsSync(authSrc)) fs.copyFileSync(authSrc, path.join(agentDir, "auth.json"));

const killPort = () => {
	try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 无进程 */ }
	let wait = 0;
	while (wait < 10000) {
		try {
			const left = execFileSync("tasklist", ["/FI", "IMAGENAME eq electron.exe"], { encoding: "utf8" });
			if (!left.includes("electron.exe")) break;
		} catch { break; }
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
		wait += 500;
	}
};
killPort();

/* ---- 起 electron ---- */
const cleanEnv = { ...process.env };
delete cleanEnv.ELECTRON_RUN_AS_NODE;
cleanEnv.PI_CODING_AGENT_DIR = agentDir;
spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), [ROOT, `--remote-debugging-port=${PORT}`], { cwd: ROOT, env: cleanEnv, detached: false, stdio: "inherit" }).unref();
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
	await sleep(1000);
	try { ready = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok; } catch { /* 未起 */ }
}
if (!ready) { console.error("electron 未就绪"); process.exit(1); }
ok("应用启动", true);
client = await CDP({ port: PORT });
await client.Runtime.enable();
await sleep(5000);

await ev(`window.__evts = []; window.openpi.onEvent((e) => window.__evts.push(e.type));`);
await ev(`startSession(${JSON.stringify(ws)})`);
await sleep(1500);

/* ①②③ minimap：先短消息，再长消息撑出滚动 */
await ev(`(() => { sendText("你好"); return 1; })()`);
await waitSettled();
await ev(`(() => { sendText("P67-LONG 长文来一段"); return 1; })()`);
await waitSettled();
await sleep(1500); // 等 minimap 重建（250ms 节流）

const mm = await ev(`(() => {
	const m = document.getElementById("minimap");
	const segs = [...m.querySelectorAll(".mm-seg")];
	return { hidden: m.hidden, segs: segs.length, userOnly: segs.every((s) => s.classList.contains("t-user")), vp: !document.getElementById("minimap-vp").hidden,
		scrollable: document.getElementById("chat").scrollHeight > document.getElementById("chat").clientHeight + 60 };
})()`);
// P75 用户定调：每个横杠=一条用户提问（回答不上轨），① 断言同步改为「段存在且全部为用户段」
ok("① minimap 显示且 segments 只含用户提问", !mm.hidden && mm.segs >= 1 && mm.userOnly, `hidden=${mm.hidden} segs=${mm.segs} userOnly=${mm.userOnly} scrollable=${mm.scrollable}`);
ok("② 视口指示器可见", mm.vp);

const before = await ev(`(() => { const c = document.getElementById("chat"); c.scrollTop = 0; return c.scrollTop; })()`);
await sleep(200);
await ev(`(() => {
	const m = document.getElementById("minimap");
	const r = m.getBoundingClientRect();
	m.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: r.top + r.height * 0.9 }));
	window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
	return 1;
})()`);
await sleep(300);
const after = await ev(`document.getElementById("chat").scrollTop`);
ok("③ 点击轨道跳转生效", after > before + 300, `scrollTop ${before} → ${after}`);

/* ④⑤⑥ 设置全局搜索 */
await ev(`openSettings()`);
await sleep(300);
await ev(`(() => { const i = document.getElementById("settings-search"); i.value = "mcp"; i.dispatchEvent(new Event("input")); return 1; })()`);
await sleep(200);
const s4 = await ev(`(() => {
	const pop = document.getElementById("settings-search-pop");
	const first = pop.querySelector(".ss-item");
	const tabHit = [...pop.querySelectorAll(".ss-item .ss-tab")].some((x) => x.textContent.includes("工具与集成"));
	return { visible: !pop.hidden, n: pop.querySelectorAll(".ss-item").length, tabHit };
})()`);
ok("④a 搜索 mcp 弹结果（含工具与集成 tab）", s4.visible && s4.n > 0 && s4.tabHit, JSON.stringify(s4));
await ev(`(() => {
	const items = [...document.querySelectorAll("#settings-search-pop .ss-item")];
	const mcpItem = items.find((x) => x.querySelector(".ss-title")?.textContent.includes("MCP")) ?? items[0];
	mcpItem.click();
	return 1;
})()`);
await sleep(400);
const s4b = await ev(`(() => ({
	activeTab: document.querySelector("#settings .tab.active")?.dataset.tab,
	flash: document.getElementById("mcp-card")?.classList.contains("flash-hl"),
}))()`);
ok("④b 点击结果跳 tools tab + mcp-card 高亮", s4b.activeTab === "tools" && s4b.flash === true, JSON.stringify(s4b));

await ev(`(() => {
	const i = document.getElementById("settings-search");
	i.value = "密钥";
	i.dispatchEvent(new Event("input"));
	i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	return 1;
})()`);
await sleep(400);
const s5 = await ev(`document.querySelector("#settings .tab.active")?.dataset.tab`);
ok("⑤ 搜索 密钥+Enter → keys tab", s5 === "keys", `active=${s5}`);

await ev(`(() => { const i = document.getElementById("settings-search"); i.value = "zzz不存在的关键词xyz"; i.dispatchEvent(new Event("input")); return 1; })()`);
await sleep(200);
const s6 = await ev(`(() => {
	const pop = document.getElementById("settings-search-pop");
	return { visible: !pop.hidden, empty: !!pop.querySelector(".ss-empty") };
})()`);
ok("⑥ 无命中显示空态", s6.visible && s6.empty, JSON.stringify(s6));

try { client.close(); } catch { /* 忽略 */ }
killPort();
llm.close();
console.log(`\ne2e-p67: ${total - fails}/${total} ${fails ? "FAIL" : "ALL GREEN"}`);
process.exit(fails ? 1 : 0);
