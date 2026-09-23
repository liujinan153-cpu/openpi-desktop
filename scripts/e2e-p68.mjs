// E2E P68：UI 第三波——流式跟随智能化 + 消息操作条 + lightbox + 回底按钮
//   ① 流式期间用户上滚 → 输出不再强拉底部（stick=false），回底按钮出现且带 live 脉冲
//   ② 点回底按钮 → 回到接近底部
//   ③ assistant hover 操作条「复制」→ 剪贴板写入成功（按钮变"已复制"）
//   ④ 「引用」→ 输入框预填 "> " 前缀
//   ⑤ markdown 图片点击 → lightbox 放大；Esc 关闭
//   ⑥ 发送新消息 → 强制回底跟随（stick 恢复）
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9373;
const LLM = 9513;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0, fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

const PNG1x1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/* ---- mock LLM：P68-STREAM 分块慢发；P68-IMG 带 markdown 图 ---- */
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const llm = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", async () => {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		let body = {};
		try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* 忽略 */ }
		const last = body.messages?.[body.messages.length - 1];
		const textOf = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
		const ask = last?.role === "user" ? textOf(last) : "";
		if (ask.includes("P68-IMG")) {
			sse(res, { choices: [{ delta: { content: `看这张图：\n\n![示例图](${PNG1x1})` } }] });
		} else if (ask.includes("P68-STREAM")) {
			for (let i = 1; i <= 8; i++) {
				const para = `第${i}段流式内容，测试跟随模式。${"这段话刻意写得足够长并且重复铺陈篇幅，确保整体回复高度远超聊天视口，产生上千像素的真实滚动空间与离底距离，这样才能验证用户上滚后流式输出不再被强行拉回底部这一核心体验修复是否真正生效，同时回底按钮应当随离底距离超过阈值而浮现并携带脉冲提示。".repeat(3)}`;
				sse(res, { choices: [{ delta: { content: para + "\n\n" } }] });
				await sleep(300); // #119：必须分块慢发才测得出流式行为
			}
		} else {
			sse(res, { choices: [{ delta: { content: "收到。P68" } }] });
		}
		sse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 500 } });
		res.write("data: [DONE]\n\n"); // #118
		res.end();
	});
});
await new Promise((r) => llm.listen(LLM, "127.0.0.1", r));

/* ---- ev / waitSettled ---- */
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

/* ---- 前置 ---- */
const ws = path.join(os.tmpdir(), "p68-ws-" + Date.now());
fs.mkdirSync(ws, { recursive: true });
const agentDir = path.join(os.tmpdir(), "p68-agent");
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

/* ①② 流式跟随 + 回底按钮 */
await ev(`window.__evts.length = 0`);
await ev(`(() => { sendText("P68-STREAM 慢流来一段"); return 1; })()`);
	// 等内容溢出视口（>400px）再滚：内容不足时 scrollTop=0 是 no-op 不触发 scroll 事件，stick 不解除会假败（时序竞态，#119 家族）
// UI v3.1 加固：挂滚动采样监听再拉顶，微延迟+事件留痕进一步压低 #119 竞态窗口
// 等内容溢出视口（>400px）再滚：内容不足时 scrollTop=0 是 no-op 不触发 scroll 事件，stick 不解除会假败（时序竞态，#119 家族）
await ev(`(async () => { for (let i = 0; i < 100; i++) { const c = document.getElementById("chat"); if (c.scrollHeight - c.clientHeight > 400) break; await new Promise(r => setTimeout(r, 100)); } return 1; })()`);
await ev(`(() => { const c = document.getElementById("chat"); c.scrollTop = 0; return 1; })()`);
await ev(`(() => { const c=document.getElementById("chat"); window.__log=[]; c.addEventListener("scroll",()=>window.__log.push([Date.now()-window.__t0,Math.round(c.scrollTop),state.stick]));return 1; })()`);
await waitSettled();
await sleep(300);
const s1 = await ev(`(() => {
	const c = document.getElementById("chat");
	const btn = document.getElementById("scroll-down");
	return { top: c.scrollTop, gap: c.scrollHeight - c.scrollTop - c.clientHeight,
		btnShown: !btn.hidden, live: btn.classList.contains("live") };
})()`);
ok("① 流式期间上滚不被强拉 + 回底按钮 live", s1.top < 200 && s1.gap > 300 && s1.btnShown && s1.live, JSON.stringify(s1));
await ev(`document.getElementById("scroll-down").click()`);
await sleep(300);
const s2 = await ev(`(() => {
	const c = document.getElementById("chat");
	return { top: c.scrollTop, gap: c.scrollHeight - c.scrollTop - c.clientHeight, btnHidden: document.getElementById("scroll-down").hidden };
})()`);
ok("② 点回底按钮回到接近底部", s2.gap < 50 && s2.btnHidden, JSON.stringify(s2));

/* ③④ 消息操作条 */
try { await client.Browser.grantPermissions({ permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }); } catch { /* 权限接口不可用时降级 */ }
const s3 = await ev(`(async () => {
	const acts = [...document.querySelectorAll("#chat .msg.assistant .msg-acts")].pop();
	if (!acts) return { found: false };
	const btn = acts.querySelector('[data-act="copy"]');
	btn.click();
	await new Promise((r) => setTimeout(r, 300));
	return { found: true, btnTxt: btn.textContent, clip: await navigator.clipboard.readText() };
})()`);
ok("③ 复制按钮写剪贴板", s3.found && s3.btnTxt === "已复制" && s3.clip.includes("第1段"), JSON.stringify({ found: s3.found, btnTxt: s3.btnTxt, clip: (s3.clip ?? "").slice(0, 30) }));
const s4 = await ev(`(() => {
	const acts = [...document.querySelectorAll("#chat .msg.assistant .msg-acts")].pop();
	acts.querySelector('[data-act="quote"]').click();
	const v = document.getElementById("input").value;
	return { filled: v.startsWith("> "), focus: document.activeElement === document.getElementById("input"), v: v.slice(0, 40) };
})()`);
ok("④ 引用按钮预填输入框", s4.filled && s4.focus, JSON.stringify(s4));

/* ⑤ lightbox */
await ev(`window.__evts.length = 0`);
await ev(`(() => { sendText("P68-IMG 带图回复"); return 1; })()`);
await waitSettled();
await sleep(600);
const s5a = await ev(`(() => {
	const img = document.querySelector("#chat .msg.assistant .body img");
	if (!img) return { hasImg: false };
	img.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	return { hasImg: true, open: !document.getElementById("lightbox").hidden };
})()`);
ok("⑤a 点击消息图片 → lightbox 打开", s5a.hasImg && s5a.open, JSON.stringify({ hasImg: s5a.hasImg, open: s5a.open }));
await ev(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
const s5b = await ev(`document.getElementById("lightbox").hidden`);
ok("⑤b Esc 关闭 lightbox", s5b === true);

/* ⑥ 发新消息强制回底 */
await ev(`(() => { const c = document.getElementById("chat"); c.scrollTop = 0; return 1; })()`);
await ev(`window.__evts.length = 0`);
await ev(`(() => { sendText("再来一句短的"); return 1; })()`);
await sleep(600); // addUserMsg 已执行
const s6 = await ev(`(() => {
	const c = document.getElementById("chat");
	return { gap: c.scrollHeight - c.scrollTop - c.clientHeight };
})()`);
ok("⑥ 用户发新消息强制回底", s6.gap < 80, JSON.stringify(s6));
await waitSettled();

try { client.close(); } catch { /* 忽略 */ }
killPort();
llm.close();
console.log(`\ne2e-p68: ${total - fails}/${total} ${fails ? "FAIL" : "ALL GREEN"}`);
process.exit(fails ? 1 : 0);
