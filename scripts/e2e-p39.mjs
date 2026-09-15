// E2E P39：向 Cursor 取经三件套（改动卡 / 命令允许清单 / 失败重试）
//   ① 本轮改动卡：edit/write 工具 → turn_file_change 事件 → 回合结束汇总卡（打开审核面板 / 全部回滚）
//   ② 命令允许清单：localStorage → agent:approval-allowlist → 审批扩展前缀匹配免确认
//   ③ 失败重试：stopReason=error 的回合挂「↻ 重试本轮」按钮
// 方法：沙箱 agent 目录 + 本地 echo server + CDP 真实链路（与 e2e-p385-vision 同款骨架）
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9335;
const ECHO = 9998;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0, fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

/* —— echo server —— */
const echo = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.write('data: {"id":"e","choices":[{"delta":{"content":"ok"},"index":0,"finish_reason":"stop"}]}\n\n');
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
echo.listen(ECHO, "127.0.0.1");

/* —— 沙箱 agent 目录 —— */
const agentDir = path.join(os.tmpdir(), "p39-agent");
fs.rmSync(agentDir, { recursive: true, force: true });
fs.mkdirSync(agentDir, { recursive: true });
const userModels = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "models.json"), "utf8"));
userModels.providers.zhipu.baseUrl = `http://127.0.0.1:${ECHO}/v1`;
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(userModels));
const authSrc = path.join(os.homedir(), ".pi", "agent", "auth.json");
if (fs.existsSync(authSrc)) fs.copyFileSync(authSrc, path.join(agentDir, "auth.json"));

/* —— 启动应用 —— */
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
const cleanEnv = { ...process.env };
delete cleanEnv.ELECTRON_RUN_AS_NODE;
for (const k of Object.keys(cleanEnv)) if (/proxy/i.test(k)) delete cleanEnv[k];
cleanEnv.PI_CODING_AGENT_DIR = agentDir;
spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), [ROOT, `--remote-debugging-port=${PORT}`], { cwd: ROOT, env: cleanEnv, detached: true, stdio: "ignore" }).unref();
let ready = false;
for (let i = 0; i < 45; i++) {
	await sleep(2000);
	try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ready = true; break; } } catch { /* 未就绪 */ }
}
await sleep(6000);
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

/* —— 会话 + 模型 —— */
const ws = path.join(os.homedir(), "p39-e2e");
fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(ws, { recursive: true });
await ev(`startSession(${JSON.stringify(ws.replace(/\\/g, "/"))}).then(() => null)`);
await sleep(1500);
await ev(`window.openpi.setModel("zhipu","glm-5.3-flash").catch(() => null)`);
await sleep(500);

/* 场景① 纯文本回合真实链路 → 回合结束不误弹改动卡 */
await ev(`window.openpi.prompt("你好").then(() => "ok").catch((e) => "ERR:" + e.message)`);
let settled = false;
for (let i = 0; i < 30; i++) {
	await sleep(1000);
	settled = await ev(`!state.streaming`);
	if (settled) break;
}
ok("场景① 纯文本回合完成", settled);
const noCard = await ev(`document.querySelectorAll(".turn-card").length`);
ok("场景① 无编辑回合不弹改动卡", noCard === 0, `cards=${noCard}`);

/* 场景② 改动卡：模拟本回合编辑了两个文件 */
await ev(`(() => {
	state.turnFiles = new Set(["src/a.js", "docs/说明.md"]);
	state.turnCard = null;
	renderTurnCard();
})()`);
const c2 = await ev(`(() => {
	const card = document.querySelector(".turn-card");
	return {
		has: !!card,
		text: card?.querySelector(".tc-head")?.textContent ?? "",
		files: [...(card?.querySelectorAll(".tc-file") ?? [])].map((x) => x.textContent),
	};
})()`);
ok("场景② 改动卡出现", c2.has === true);
ok("场景② 汇总文件数", /2/.test(c2.text ?? "") && c2.files?.length === 2, JSON.stringify(c2));
ok("场景② 文件名正确", c2.files?.includes("src/a.js") && c2.files?.includes("docs/说明.md"), JSON.stringify(c2.files));
await ev(`document.querySelector(".turn-card .tc-review").click()`);
await sleep(600);
const dockOpen = await ev(`({ tab: dockTab, hidden: dock.hidden })`);
ok("场景② 打开审核面板", dockOpen.tab === "review" && dockOpen.hidden === false, JSON.stringify(dockOpen));

/* 场景③ 命令允许清单：UI 弹层 → 添加 → 保存 → localStorage + IPC */
await ev(`document.getElementById("allow-btn").click()`);
await sleep(300);
const maskShown = await ev(`!document.getElementById("allow-mask").hidden`);
ok("场景③ 允许清单弹层打开", maskShown === true);
await ev(`(() => {
	document.getElementById("allow-input").value = "npm run lint";
	document.getElementById("allow-add").click();
	document.getElementById("allow-save").click();
})()`);
await sleep(400);
const c3 = await ev(`JSON.parse(localStorage.getItem("op-allowlist") || "[]")`);
ok("场景③ 清单已持久化", Array.isArray(c3) && c3.includes("npm run lint"), JSON.stringify(c3));

/* 场景④ 重试按钮：error 回合挂「重试本轮」 */
await ev(`(() => {
	state.lastPrompt = { text: "你好", images: [] }; // 真实流程由 sendText 设置
	const div = document.createElement("div");
	div.className = "retry-test";
	document.body.appendChild(div);
	mountRetryChip({ bodyEl: div });
})()`);
const c4 = await ev(`(() => {
	const b = [...document.querySelectorAll(".retry-chip")].at(-1);
	return { has: !!b, label: b?.textContent ?? "" };
})()`);
ok("场景④ 重试按钮已挂载", c4.has === true, JSON.stringify(c4));
ok("场景④ 重试按钮文案", /重试本轮/.test(c4.label ?? ""));

echo.close();
const shotR = await client.Page.captureScreenshot({ format: "png", fromSurface: true }).catch(() => null);
if (shotR) fs.writeFileSync("e2e/p39.png", Buffer.from(shotR.data, "base64"));
try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 无进程 */ }
fs.rmSync(ws, { recursive: true, force: true });
fs.rmSync(agentDir, { recursive: true, force: true });
console.log("📸 e2e/p39.png");
console.log(fails ? `\n${total - fails}/${total} 通过` : `\n全部通过 ✓ ${total}/${total}`);
process.exit(fails ? 1 : 0);
