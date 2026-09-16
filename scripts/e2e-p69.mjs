// E2E P69：功能短板——① 后台任务取消通道（面板 ✕ 取消 → worker abort → status=cancelled）
//           ② Codex/OpenCode 会话导入（PI_HOME 隔离 fixture → 探测+导入落盘）
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9374;
const LLM = 9514;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0, fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

/* ---- mock LLM：默认秒回；带慢流标记时 20 块 × 400ms（给取消留窗口） ---- */
const sse = (res, obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* abort 后连接已断 */ } };
const llm = http.createServer((req, res) => {
	req.on("error", () => {}); res.on("error", () => {}); // #EPIPE 容忍
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", async () => {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		let body = {};
		try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* 忽略 */ }
		const last = body.messages?.[body.messages.length - 1];
		const textOf = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
		const ask = last?.role === "user" ? textOf(last) : "";
		if (ask.includes("P69-SLOW")) {
			for (let i = 1; i <= 20; i++) {
				sse(res, { choices: [{ delta: { content: `慢流第${i}块。` } }] });
				await sleep(400);
			}
		} else {
			sse(res, { choices: [{ delta: { content: "收到。P69" } }] });
		}
		sse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 500 } });
		res.write("data: [DONE]\n\n"); // #118
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

/* ---- 隔离：临时 PI_HOME + 导入 fixture + 独立 agentDir/workspace ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p69-e2e-"));
const tmpHome = path.join(tmp, "home"); // PI_HOME（导入源 + pi 会话根都隔离在这）
fs.mkdirSync(tmpHome, { recursive: true });
// fixture：Codex rollout
const codexDir = path.join(tmpHome, ".codex", "sessions", "2026", "06", "06");
fs.mkdirSync(codexDir, { recursive: true });
fs.writeFileSync(path.join(codexDir, "rollout-2026-06-06T23-30-36-abc.jsonl"), [
	JSON.stringify({ timestamp: "2026-06-06T15:30:36.956Z", type: "session_meta", payload: { session_id: "abc", cwd: "C:\\proj" } }),
	JSON.stringify({ timestamp: "2026-06-06T15:31:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "你好，帮我写个函数" }] } }),
	JSON.stringify({ timestamp: "2026-06-06T15:32:37.464Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "好的，函数如下" }] } }),
].join("\n"));
// fixture：OpenCode storage（布局 B）
const st = path.join(tmpHome, ".local", "share", "opencode", "storage");
fs.mkdirSync(path.join(st, "session", "projX"), { recursive: true });
fs.writeFileSync(path.join(st, "session", "projX", "ses_1.json"), JSON.stringify({ id: "ses_1", title: "修 bug", time: { created: 1000 } }));
fs.mkdirSync(path.join(st, "message", "ses_1", "msg_1"), { recursive: true });
fs.writeFileSync(path.join(st, "message", "ses_1", "msg_1", "info.json"), JSON.stringify({ id: "msg_1", role: "user" }));
fs.mkdirSync(path.join(st, "part", "ses_1", "msg_1"), { recursive: true });
fs.writeFileSync(path.join(st, "part", "ses_1", "msg_1", "part_1.json"), JSON.stringify({ type: "text", text: "这个报错怎么修" }));

const ws = path.join(tmp, "ws");
fs.mkdirSync(ws, { recursive: true });
const agentDir = path.join(tmp, "agent");
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
cleanEnv.PI_HOME = tmpHome; // p64b 同款隔离：导入源 ~/.codex → tmpHome（USERPROFILE 不可动）
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

/* ② 导入链路（IPC 层）：探测 fixture 三来源 + codex 落盘 */
const s2 = await ev(`(async () => {
	const scan = await window.openpi.sessionsImportScan();
	const kinds = scan.map((s) => s.kind);
	const out = { kinds, claudeDetected: false, codexCount: 0, ocCount: 0, imported: null };
	for (const s of scan) {
		if (s.kind === "codex") out.codexCount = s.count;
		if (s.kind === "opencode") out.ocCount = s.count;
		if (s.kind === "claude-code") out.claudeDetected = true;
	}
	const r = await window.openpi.sessionsImportDo("codex");
	out.imported = r.imported;
	return out;
})()`);
ok("②a 探测到 codex(1)+opencode(1)", s2.kinds.includes("codex") && s2.kinds.includes("opencode") && s2.codexCount === 1 && s2.ocCount === 1, JSON.stringify(s2));
ok("②b codex 导入落盘 1 条", s2.imported === 1, JSON.stringify(s2.imported));
const s2c = await ev(`(async () => {
	const r = await window.openpi.sessionsImportDo("opencode");
	return r.imported;
})()`);
ok("②c opencode 导入落盘 1 条", s2c === 1, String(s2c));

/* ① 后台任务取消：发起慢流任务 → 面板出现 ✕ → 点击 → status=cancelled */
await ev(`(async () => { await window.openpi.taskStart("P69-SLOW 慢流任务用来测取消"); return 1; })()`);
await sleep(2500);
const pane1 = await ev(`(async () => { await renderTasksPane(); await new Promise((r) => setTimeout(r, 400)); return 1; })()`);
const s1a = await ev(`(() => {
	const btn = document.querySelector("#tasks-body .task-cancel");
	if (!btn) return { found: false };
	return { found: true, txt: btn.textContent };
})()`);
ok("①a running 任务行出现 ✕ 取消按钮", s1a.found === true, JSON.stringify(s1a));
if (s1a.found) {
	await ev(`(() => { document.querySelector("#tasks-body .task-cancel").click(); return 1; })()`);
	let st = null;
	for (let i = 0; i < 20; i++) {
		await sleep(600);
		st = await ev(`(async () => (await window.openpi.taskList()).map((t) => t.status))()`);
		if (!st.includes("running")) break;
	}
	ok("①b 点击后任务状态 → cancelled", Array.isArray(st) && st.includes("cancelled") && !st.includes("running"), JSON.stringify(st));
	const s1c = await ev(`(async () => { await renderTasksPane(); await new Promise((r) => setTimeout(r, 300));
		return document.querySelector("#tasks-body").textContent.includes("已取消"); })()`);
	ok("①c 面板显示「已取消」", s1c === true);
} else {
	fails++; total++; // 补两个失败占位
	fails++; total++;
}

/* 幂等复查：导入会话文件出现在 pi sessions 根 */
const grp = path.join(tmpHome, ".pi", "agent", "sessions");
const grpList = fs.existsSync(grp) ? fs.readdirSync(grp).filter((d) => d.includes("--imported")) : [];
ok("③ 导入会话进 pi 会话目录（可搜索回看）", grpList.length >= 2, JSON.stringify(grpList));

try { client.close(); } catch { /* 忽略 */ }
killPort();
llm.close();
console.log(`\ne2e-p69: ${total - fails}/${total} ${fails ? "FAIL" : "ALL GREEN"}`);
process.exit(fails ? 1 : 0);
