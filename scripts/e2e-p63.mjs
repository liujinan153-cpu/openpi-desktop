// E2E P63：LSP 语义诊断 + 目标模式
//   ① lsp_diag 对坏 TS 文件报语义错误（类型错误/不存在成员）
//   ② 目标模式 UI 链路：select 切 goal → goal-bar 输入目标 → 锁定 → 审批档位生效
//   ③ goal 档提示注入：mock LLM system 提示含「目标模式」+ 用户目标文本
//   ④ goal 档审批直通：AI 写文件不弹审批，磁盘落盘铁证
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9363;
const LLM = 9503;
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
	if (process.env.P63_DUMP) console.error("[p63mock] 收到请求");
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		let body = {};
		try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* 忽略 */ }
		const last = body.messages?.[body.messages.length - 1];
		const systemMsg = body.messages?.find((m) => m.role === "system");
		const sysText = typeof systemMsg?.content === "string" ? systemMsg.content : JSON.stringify(systemMsg?.content ?? "");
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
		const ws = path.join(os.homedir(), "openpi-workspace");
		// 流程 A：lsp_diag 诊断坏 TS 文件 → finish
		if (last?.role === "user" && textOf(last).includes("P63-DIAG")) {
			toolCall("a1", "lsp_diag", { path: "p63-bad.ts" });
		} else if (last?.role === "tool" && globalThis.p63phase === "diag") {
			globalThis.p63phase = "diag-done";
			globalThis.p63diag = `diag=${textOf(last).includes("语义错误") ? 1 : 0} tscode=${textOf(last).includes("TS") ? 1 : 0}`;
			finish(`P63 语义诊断结果如下：${globalThis.p63diag}，共发现上述类型错误，请修复后再跑一次。END63D`);
		}
		// 流程 B：goal 模式 → write 直通 → finish
		else if (last?.role === "user" && textOf(last).includes("P63-GOAL")) {
			globalThis.p63sys = sysText;
			if (process.env.P63_DUMP) console.error("[p63sys] goal?", sysText.includes("目标模式"), "len:", sysText.length, "尾部:", JSON.stringify(sysText.slice(-150)));
			toolCall("b1", "write", { path: "p63-goal-proof.txt", content: "goal-mode-direct-write" });
		} else if (last?.role === "tool" && globalThis.p63phase === "goal") {
			globalThis.p63phase = "goal-done";
			const hasGoal = sysText.includes("目标模式") ? 1 : 0;
			const hasText = sysText.includes("验收标准A1") && sysText.includes("验收标准B2") ? 1 : 0;
			const toolText = textOf(last);
			if (process.env.P63_DUMP) console.error("[p63tool] result:", JSON.stringify(toolText.slice(0, 200)), "blocked?", /拒绝|失败|blocked|denied/i.test(toolText));
			const wrote = !/拒绝|失败|blocked|denied/i.test(toolText) ? 1 : 0;
			globalThis.p63result = `goal=${hasGoal} text=${hasText} wrote=${wrote}`;
			globalThis.p63done = true;
			finish(`P63 目标模式执行完毕：${globalThis.p63result}，验收对照表如下所示，全部满足。END63G`);
		} else {
			finish("收到。");
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
llm.listen(LLM, "127.0.0.1");

/* ---- 前置：workspace + 坏 TS 靶子 ---- */
const ws = path.join(os.homedir(), "openpi-workspace");
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "openpi-ws", version: "1.0.0" }, null, 2));
fs.writeFileSync(path.join(ws, "p63-bad.ts"), "export function bad(x: number): string {\n  return x.notAMethod();\n}\nexport const n: string = 123;\n");
fs.rmSync(path.join(ws, "p63-goal-proof.txt"), { force: true });
fs.rmSync(path.join(ws, ".openpi", "hooks.json"), { force: true }); // p58 遗留的验证门槛 hook 会对 .txt 写入报 hook 失败干扰 tool result
globalThis.p63phase = "diag";
console.log("[前置] workspace 就绪");

/* ---- 沙箱 agentDir ---- */
const agentDir = path.join(os.tmpdir(), "p63-agent");
fs.rmSync(agentDir, { recursive: true, force: true });
fs.mkdirSync(agentDir, { recursive: true });
const userModels = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "models.json"), "utf8"));
userModels.providers.zhipu.baseUrl = `http://127.0.0.1:${LLM}/v1`;
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(userModels));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "zhipu", defaultModel: "glm-5.2" }));
const authSrc = path.join(os.homedir(), ".pi", "agent", "auth.json");
if (fs.existsSync(authSrc)) fs.copyFileSync(authSrc, path.join(agentDir, "auth.json"));

const killPort = () => {
	// 坑（#91 家族）：残留 electron 实例会让新实例行为怪异（气泡空/工具挂）——先杀净再复查
	try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 无进程 */ }
	let wait = 0;
	while (wait < 10000) {
		try {
			const left = execFileSync("tasklist", ["/FI", "IMAGENAME eq electron.exe"], { encoding: "utf8" });
			if (!left.includes("electron.exe")) break;
		} catch { break; }
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); // 同步等 500ms（Windows 无 sleep 命令，execFileSync 会 ENOENT）
		wait += 500;
	}
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
	// 从 anchor 首次出现处截取（气泡内 tool 卡文本很长，从头截会吃掉断言区）
	for (let i = 0; i < 300; i++) {
		await new Promise(r => setTimeout(r, 500));
		const asst = [...document.querySelectorAll(".msg.assistant")].filter(m => m.textContent.includes("${anchor}"));
		if (asst.length) { const t = asst.at(-1).textContent; const p = Math.max(0, t.indexOf("${anchor}") - 10); return t.slice(p, p + 500); }
	}
	const asst = [...document.querySelectorAll(".msg.assistant")];
	return "[EMPTY] html:" + asst.map((m,i)=>i+":"+m.innerHTML.slice(0,200)).join(" @@ ");
})()`);

/* ⓪ 切到 git 工作区会话 */
await ev(`startSession(${JSON.stringify(ws)})`);
await sleep(1500);
ok("⓪ 切到工作区会话", true);

/* ① lsp_diag 诊断坏文件（断言取 mock 端变量，渲染层气泡是流式的，文本截取时机不稳定） */
globalThis.p63diag = null;
await ev(`(() => { sendText("P63-DIAG 用语义诊断检查 p63-bad.ts 有什么类型错误"); return 1; })()`);
for (let i = 0; i < 120 && globalThis.p63diag === null; i++) await sleep(500);
await sleep(1000); // 等 tool result 完整
const t1 = globalThis.p63diag ?? "[TIMEOUT] diag 流程未完成";
ok("① lsp_diag 报出语义错误", t1.includes("diag=1"), t1.slice(0, 120));
ok("② 错误带 TS 诊断码", t1.includes("tscode=1"), t1.slice(0, 120));
if (process.env.P63_DUMP) console.log("[p63dump] t1:", t1.slice(0, 400));

/* ② goal 模式 UI 链路：select → 输入条 → 锁定 */
const goalUi = await ev(`(async () => {
	const sel = document.querySelector("#approval-select");
	sel.value = "goal";
	sel.dispatchEvent(new Event("change", { bubbles: true }));
	await new Promise(r => setTimeout(r, 300));
	const bar = document.querySelector("#goal-bar");
	if (bar.hidden) return "BAR-NOT-SHOWN";
	document.querySelector("#goal-text").value = "完成 P63-GOAL 验证任务。验收标准A1：写入 p63-goal-proof.txt。验收标准B2：内容为 goal-mode-direct-write。";
	document.querySelector("#btn-goal-start").click();
	await new Promise(r => setTimeout(r, 500));
	return "LOCKED sel=" + sel.value + " barHidden=" + bar.hidden;
})()`);
ok("③ goal 输入条弹出且锁定成功", goalUi.includes("LOCKED") && goalUi.includes("sel=goal") && goalUi.includes("barHidden=true"), goalUi);

/* ③ goal 模式全链路：审批直通写文件 + 提示注入 */
globalThis.p63phase = "goal";
await ev(`(() => { sendText("P63-GOAL 按目标执行：直接写入 p63-goal-proof.txt"); return 1; })()`);
for (let i = 0; i < 120 && !globalThis.p63done; i++) await sleep(500);
const t2 = globalThis.p63result ?? "[TIMEOUT] mock 未收到完整流程";
ok("④ goal 提示注入系统提示", t2.includes("goal=1"), t2.slice(0, 120));
ok("⑤ 目标+验收标准文本注入", t2.includes("text=1"), t2.slice(0, 120));
ok("⑥ goal 档写文件无审批拦截", t2.includes("wrote=1"), t2.slice(0, 120));
if (process.env.P63_DUMP) console.log("[p63dump] t2:", t2.slice(0, 400));

/* ⑦ 磁盘铁证 */
const proof = fs.existsSync(path.join(ws, "p63-goal-proof.txt")) ? fs.readFileSync(path.join(ws, "p63-goal-proof.txt"), "utf8") : "";
ok("⑦ goal 写入落盘铁证", proof.includes("goal-mode-direct-write"), JSON.stringify(proof.slice(0, 60)));

/* 清理 */
try { client.close(); } catch { /* 忽略 */ }
try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 已退出 */ }
await sleep(1500);
llm.close();
console.log(fails === 0 ? `✅ e2e-p63 ${total} 过 0 败` : `❌ e2e-p63 ${total - fails} 过 ${fails} 败`);
process.exit(fails === 0 ? 0 : 1);
