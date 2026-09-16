// E2E P66：渐进流式渲染（真实分块 delta，修复「流式不实时显示」盲区）
//   mock 先 8 块 thinking（reasoning_content）再 12 块正文，300ms/块：
//   ① 流式途中（agent_settled 之前）DOM .msg.assistant .body 就有部分文本（渐进渲染活着）
//   ② message_update 事件大量到达渲染层（链路 worker→proxy→renderer 通畅）
//   ③ 结束后全文完整落 DOM
//   ④ 思考阶段 thinking 条自动展开 + 字数实时涨（glm-5.2 thinking=high 长思考期的实时反馈）
//   ⑤ 正文首 delta / 结束后 thinking 条折叠
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9370;
const LLM = 9510;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0, fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

/* ---- mock LLM：P66-STREAM → 8 thinking + 12 text 慢流 ---- */
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
let mockReqSeq = 0;
const llm = http.createServer((req, res) => {
	const rq = ++mockReqSeq;
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		let body = {};
		try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* 忽略 */ }
		const last = body.messages?.[body.messages.length - 1];
		const textOf = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
		if (last?.role === "user" && textOf(last).includes("P66-STREAM")) {
			console.error(`[mock#${rq}] slow-stream 8 thinking + 12 text x 300ms`);
			let i = 0;
			const timer = setInterval(() => {
				i++;
				if (i <= 8) sse(res, { choices: [{ delta: { reasoning_content: `思${i}·` } }] }); // glm-5.2 thinking=high：先思考后正文
				else sse(res, { choices: [{ delta: { content: `第${i - 8}块·` } }] });
				if (i >= 20) {
					clearInterval(timer);
					sse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 80 } });
					res.write("data: [DONE]\n\n"); // #118：必须 [DONE]+end
					res.end();
					console.error(`[mock#${rq}] stream done`);
				}
			}, 300);
		} else {
			sse(res, { choices: [{ delta: { content: "收到。P66" } }] });
			sse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
			res.write("data: [DONE]\n\n");
			res.end();
		}
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

/* ---- 前置：独立 workspace ---- */
const ws = path.join(os.tmpdir(), "p66-ws-" + Date.now());
fs.mkdirSync(ws, { recursive: true });
const agentDir = path.join(os.tmpdir(), "p66-agent");
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

await ev(`window.__evts = []; window.openpi.onEvent((e) => window.__evts.push(e.type + (e.message?.role ? ":" + e.message.role : "")));`);
await ev(`startSession(${JSON.stringify(ws)})`);
await sleep(1500);

/* 发消息，边流边采样 DOM */
await ev(`(() => { sendText("P66-STREAM 慢慢说"); return 1; })()`);
const timeline = [];
for (let i = 0; i < 40; i++) {
	await sleep(300); // 采样 12s，mock 流 6s
	const snap = await ev(`(() => {
		const bodies = [...document.querySelectorAll(".msg.assistant .body")];
		const last = bodies[bodies.length - 1];
		const th = last ? last.querySelector("details.thinking") : null;
		return { len: last ? last.textContent.length : -1, head: last ? last.textContent.slice(0, 24) : "", settled: (window.__evts ?? []).some(t => t === "agent_settled"), updates: (window.__evts ?? []).filter(t => t === "message_update:assistant").length, thinkOpen: th ? th.open : null, thinkLen: th ? th.querySelector(".content").textContent.length : 0 };
	})()`);
	timeline.push({ t: (i + 1) * 300, ...snap });
	if (snap.settled && snap.len >= 0 && i > 3) { /* 留几拍再停 */ if (timeline.filter(s => s.settled).length >= 2) break; }
}
console.log("[timeline]", JSON.stringify(timeline.filter((s, i) => i % 2 === 0 || s.len > 0 || s.thinkOpen)));

/* 断言 */
const firstGrow = timeline.find((s) => s.len > 0);
const settledAt = timeline.find((s) => s.settled);
ok("① 流式途中 DOM 渐进出现文本", !!firstGrow && !!settledAt && firstGrow.t <= settledAt.t, `首现 t=${firstGrow?.t}ms head="${firstGrow?.head ?? ""}" settled t=${settledAt?.t ?? "never"}ms`);
const updCount = timeline.at(-1)?.updates ?? 0;
ok("② message_update 大量到达渲染层", updCount >= 15, `updates=${updCount} (8 thinking + 12 text)`);
const finalLen = timeline.at(-1)?.len ?? 0;
ok("③ 结束后全文完整", finalLen >= 60, `len=${finalLen} (期望≥60)`);
const thinkOpenSample = timeline.find((s) => s.thinkOpen === true && s.thinkLen > 0);
const thinkGrew = timeline.find((s) => s.thinkLen >= 4);
ok("④ 思考流式期间自动展开+字数实时涨", !!thinkOpenSample && !!thinkGrew, `open@t=${thinkOpenSample?.t ?? "never"}ms thinkLen=${thinkOpenSample?.thinkLen ?? 0}`);
ok("⑤ 正文/结束后思考条折叠", timeline.at(-1)?.thinkOpen === false, `final thinkOpen=${timeline.at(-1)?.thinkOpen}`);

try { client.close(); } catch { /* 忽略 */ }
killPort();
llm.close();
console.log(`\ne2e-p66: ${total - fails}/${total} ${fails ? "FAIL" : "ALL GREEN"}`);
process.exit(fails ? 1 : 0);
