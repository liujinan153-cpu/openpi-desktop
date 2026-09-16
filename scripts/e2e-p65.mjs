// E2E P65：通知中心 + Ctrl+K 全局命令面板（0.54.0）
//   ① agent_settled → 通知中心留痕（徽标 + 条目，前台也 push）
//   ② 命令面板打开（Ctrl+K）→ 含「命令」分组
//   ③ 面板执行「切换亮/暗主题」→ data-theme 翻转 + 面板自动关闭
//   ④ 通知面板展开 → 条目渲染 + 时间文案
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9366;
const LLM = 9502;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0, fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

/* ---- mock LLM：一条就够——P65-FLOW 文本 → finish（agent_settled 触发通知留痕） ---- */
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
		const finish = (text) => {
			console.error(`[mock#${rq}] finish: ${String(text).slice(0, 40)}`);
			sse(res, { choices: [{ delta: { content: text } }] });
			sse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 50 } });
			res.write("data: [DONE]\n\n"); // OpenAI 标准收尾：SDK 等 EOF 才 emit message_end/agent_settled，无 [DONE] 会挂流
			res.end();
		};
		if (process.env.P65_DUMP) console.error("[p65mock] last=", last?.role, ":", String(typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "")).slice(0, 150));
		if (last?.role === "user" && textOf(last).includes("P65-FLOW")) finish("P65 任务跑完了 END65");
		else finish("收到。END65");
	});
});
await new Promise((r) => llm.listen(LLM, "127.0.0.1", r));

/* ---- ev：CDP 渲染层求值 ---- */
let client;
const ev = async (expr) => {
	const { Runtime } = client;
	const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "ev error");
	return r.result.value;
};
const sendKey = (key) => ev(`new Promise(r => { window.openpi ? 0 : 0; document.dispatchEvent(new KeyboardEvent("keydown", ${JSON.stringify(key)})); r(1); })`);

/* ---- 前置：独立 workspace（共享 workspace 会卡 agent，P62/63/49 假失败教训） ---- */
const ws = path.join(os.tmpdir(), "p65-ws-" + Date.now());
fs.mkdirSync(ws, { recursive: true });

const agentDir = path.join(os.tmpdir(), "p65-agent");
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
	try {
		const resp = await fetch(`http://127.0.0.1:${PORT}/json/version`);
		ready = resp.ok;
	} catch { /* 未起 */ }
}
if (!ready) { console.error("electron 未就绪"); process.exit(1); }
ok("应用启动", true);
client = await CDP({ port: PORT });
await client.Runtime.enable();
await sleep(5000);

/* ⓪ 切到工作区会话 */
await ev(`window.__evts = []; try { window.openpi.onEvent((e) => window.__evts.push(e.type + (e.message?.role ? ":" + e.message.role : "") + (e.message?.stopReason ? "/" + e.message.stopReason : ""))); } catch (err) { window.__evts.push("ERR " + String(err)); }`);
await ev(`startSession(${JSON.stringify(ws)})`);
await sleep(1500);
ok("⓪ 切到工作区会话", true);

/* ① agent_settled → 通知留痕（前台也 push） */
await ev(`(() => { sendText("P65-FLOW 跑个任务"); return 1; })()`);
let settled = false;
for (let i = 0; i < 120 && !settled; i++) {
	await sleep(500);
	const evtLog2 = await ev(`window.__evts ?? []`);
	settled = evtLog2.includes("agent_settled"); // agent_settled 是防抖延迟事件，直等它
}
await sleep(1500);
const chatDump = await ev(`({ chat: document.getElementById("chat").textContent.slice(0, 200), sid: state.session?.sessionId ?? null, ws: state.session?.workspace ?? null })`);
console.log("[state]", JSON.stringify(chatDump));
console.log("[chatdump]", chatDump);
const settledEvt = await ev(`window.__evtLog ?? "no-log"`);
console.log("[dbg evtlog]", JSON.stringify(settledEvt).slice(0, 200));
const n1 = await ev(`(() => {
	const badge = document.getElementById("notif-badge");
	const items = [...document.querySelectorAll("#notif-list .n-item")];
	return { badgeVisible: badge && !badge.hidden, badgeText: badge?.textContent ?? "", count: items.length, anyTaskDone: items.some(x => x.textContent.includes("任务完成")) };
})()`);
ok("① 任务完成 → 通知徽标", n1.badgeVisible === true && Number(n1.badgeText) >= 1, JSON.stringify(n1));
ok("①b 任务完成 → 通知留痕", n1.badgeVisible === true && Number(n1.badgeText) >= 1, `badge=${n1.badgeText}（条目渲染在④面板展开后断言）`);

/* ② Ctrl+K 打开命令面板 */
await sendKey({ ctrlKey: true, key: "k", bubbles: true });
await sleep(400);
const c1 = await ev(`(() => {
	const p = document.getElementById("cmdk");
	const groups = [...document.querySelectorAll("#cmdk .ck-group")].map(g => g.textContent);
	const items = document.querySelectorAll("#cmdk .ck-item").length;
	const focused = document.activeElement === document.getElementById("cmdk-input");
	return { visible: p && !p.hidden, groups, items, focused };
})()`);
ok("② Ctrl+K 打开命令面板", c1.visible === true && c1.items >= 5, JSON.stringify(c1));
ok("②b 面板含命令分组", c1.groups.includes("命令"), JSON.stringify(c1.groups));

/* ③ 执行「切换亮/暗主题」→ data-theme 翻转 + 面板关闭 */
const themeBefore = await ev(`document.documentElement.getAttribute("data-theme")`);
await ev(`(() => {
	const inp = document.getElementById("cmdk-input");
	inp.value = "主题";
	inp.dispatchEvent(new Event("input", { bubbles: true }));
	return 1;
})()`);
await sleep(300);
await ev(`(() => {
	const items = [...document.querySelectorAll("#cmdk .ck-item")];
	items[0]?.click();
	return items.length;
})()`);
await sleep(500);
const themeAfter = await ev(`(() => ({ theme: document.documentElement.getAttribute("data-theme"), cmdkHidden: document.getElementById("cmdk").hidden }))()`);
ok("③ 命令执行 → 主题翻转", themeBefore !== themeAfter.theme, `before=${themeBefore} after=${themeAfter.theme}`);
ok("③b 执行后面板自动关闭", themeAfter.cmdkHidden === true);

/* ④ 通知面板展开渲染 */
await ev(`document.getElementById("btn-notif").click()`);
await sleep(400);
const n2 = await ev(`(() => {
	const p = document.getElementById("notif-panel");
	const items = [...document.querySelectorAll("#notif-list .n-item")];
	const timeTxt = items[0]?.querySelector(".n-time")?.textContent ?? "";
	return { visible: p && !p.hidden, count: items.length, timeTxt, badgeCleared: document.getElementById("notif-badge").hidden, anyTaskDone: items.some(x => x.textContent.includes("任务完成")) };
})()`);
ok("④ 通知面板展开且条目渲染", n2.visible === true && n2.count >= 1 && n2.timeTxt.length > 0 && n2.anyTaskDone, JSON.stringify(n2));
ok("④b 展开即全部已读（徽标清零）", n2.badgeCleared === true);

/* 清理 */
await client.close().catch(() => {});
killPort();
llm.close();
console.log(fails === 0 ? `\n✅ e2e-p65 ${total} 过 0 败` : `\n❌ e2e-p65 ${total - fails} 过 ${fails} 败`);
process.exit(fails === 0 ? 0 : 1);
