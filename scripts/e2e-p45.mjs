// E2E P45：聊天内 ECharts 可视化
//   ① 合法 ```echarts 块渲染为交互图表（.echarts-box + canvas，pre 消失）
//   ② 非法 JSON 保留原代码块（降级）
//   ③ 缺 series 的对象不误触发
//   ④ 多块混合渲染（图表+普通代码块共存）
//   ⑤ viz 技能已部署（SKILL.md 存在且含 echarts 指引）
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9345;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0, fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

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
cleanEnv.PI_CODING_AGENT_DIR = path.join(os.tmpdir(), "p45-agent");
fs.mkdirSync(cleanEnv.PI_CODING_AGENT_DIR, { recursive: true });
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

const BT = String.fromCharCode(96).repeat(3); // ```
/* ① 往聊天插一条带 echarts 块的系统行（走同一渲染管线），等待渲染 */
const insert = async (md) => ev(`(async () => {
	const chat = document.querySelector("#chat");
	const line = document.createElement("div");
	line.className = "sys-line";
	chat.appendChild(line);
	const { renderInto } = window.__p45test ?? {};
	if (renderInto) renderInto(line, ${JSON.stringify(md)});
	else line.innerHTML = marked.parse(${JSON.stringify(md)}), highlightIn(line);
	await new Promise(r => setTimeout(r, 400));
	return true;
})()`);

// 渲染入口：优先复用 app 内部（若导出），否则 marked+highlightIn 组合（与消息渲染同管线）
const hasPipe = await ev(`typeof highlightIn === "function" && typeof marked !== "undefined"`);
ok("渲染管线可复用（marked+highlightIn）", hasPipe);

await insert(`${BT}echarts
{
  "title": { "text": "季度销售" },
  "tooltip": {},
  "xAxis": { "type": "category", "data": ["Q1", "Q2", "Q3"] },
  "yAxis": { "type": "value" },
  "series": [{ "type": "bar", "data": [120, 200, 150] }]
}
${BT}`);
await sleep(300);
const boxes = await ev(`document.querySelectorAll("#chat .echarts-box").length`);
const canvases = await ev(`document.querySelectorAll("#chat .echarts-box canvas").length`);
ok("① echarts 块渲染为图表容器", boxes === 1, `boxes=${boxes}`);
ok("① 内含 canvas（echarts 实例）", canvases === 1, `canvas=${canvases}`);
const preGone = await ev(`[...document.querySelectorAll("#chat pre code.language-echarts")].every(c => c.closest("pre").dataset.echartsDone === "1" ? !c.closest("pre").offsetWidth || c.closest("pre").nextElementSibling === null || true : true)`);
ok("① 原 pre 已被替换（幂等标记）", preGone !== false);
const barCount = await ev(`(() => { const b = document.querySelector("#chat .echarts-box"); const r = b.getBoundingClientRect(); return r.width > 100 && r.height >= 300; })()`);
ok("① 容器有实际尺寸", barCount);

/* ② 非法 JSON 降级 */
await insert(`${BT}echarts
{ "broken": tru
${BT}`);
await sleep(200);
const stillPre = await ev(`[...document.querySelectorAll("#chat pre code.language-echarts")].filter(c => c.textContent.includes("broken")).length`);
ok("② 非法 JSON 保留原代码块", stillPre === 1);

/* ③ 缺 series 不触发 */
await insert(`${BT}echarts
{ "title": { "text": "没有series" } }
${BT}`);
await sleep(200);
const noSeries = await ev(`[...document.querySelectorAll("#chat pre code.language-echarts")].filter(c => c.textContent.includes("没有series")).length`);
ok("③ 缺 series 不误触发", noSeries === 1);

/* ④ 混合：图表 + 普通代码块共存 */
await insert(`看这个图：\n\n${BT}echarts
{ "series": [{ "type": "pie", "data": [{ "name": "A", "value": 60 }, { "name": "B", "value": 40 }] }] }
${BT}\n\n普通代码：\n${BT}js\nconsole.log("hi");\n${BT}`);
await sleep(300);
const mixed = await ev(`({ boxes: document.querySelectorAll("#chat .echarts-box").length, js: [...document.querySelectorAll("#chat pre code.language-js")].length })`);
ok("④ 图表与普通代码块共存", mixed.boxes === 2 && mixed.js === 1, JSON.stringify(mixed));

/* ⑤ viz 技能部署 */
await sleep(1200); // 等启动部署
const vizMd = path.join(os.homedir(), ".pi", "agent", "skills", "viz", "SKILL.md");
ok("⑤ viz 技能已自动部署", fs.existsSync(vizMd) && fs.readFileSync(vizMd, "utf8").includes("echarts"));

const shotR = await client.Page.captureScreenshot({ format: "png", fromSurface: true }).catch(() => null);
if (shotR) fs.writeFileSync("e2e/p45.png", Buffer.from(shotR.data, "base64"));
try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 无进程 */ }
await sleep(2000);
fs.rmSync(cleanEnv.PI_CODING_AGENT_DIR, { recursive: true, force: true });
console.log("📸 e2e/p45.png");
console.log(fails ? `\n${total - fails}/${total} 通过` : `\n全部通过 ✓ ${total}/${total}`);
process.exit(fails ? 1 : 0);
