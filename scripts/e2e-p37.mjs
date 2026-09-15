// E2E P37：产物文件卡 + 贴图视觉提示 + 办公产物规范（v0.33.0）
// 覆盖：① 文件卡渲染（绝对路径/z:code私有标记/缺失态）② start 返回 model.input ③ 贴图无视觉提示
// ④ 右键菜单（打开/资源管理器定位/复制路径）⑤ 真实模型：产物落工作区 + 回报绝对路径 → 卡片出现
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0;
let fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};
const ev = async (expr) => {
	const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.slice(0, 500));
	return r.result.value;
};
const shot = async (name) => {
	const r = await client.Page.captureScreenshot({ format: "png", fromSurface: true });
	fs.mkdirSync(path.join(ROOT, "e2e"), { recursive: true });
	fs.writeFileSync(path.join(ROOT, "e2e", name), Buffer.from(r.data, "base64"));
	console.log(`📸 ${name}`);
};
const waitSettled = async (timeout = 360000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const s = await ev(`({ streaming: state.streaming, has: !!state.session })`);
		if (s.has && !s.streaming) return true;
		await sleep(3000);
	}
	return false;
};

/* 工作区：~/p37-e2e（全新）；若被残留的 Office 进程锁住（上轮左键打开测试），温和杀掉后重试 */
const WS = path.join(os.homedir(), "p37-e2e");
try {
	fs.rmSync(WS, { recursive: true, force: true });
} catch {
	for (const proc of ["WINWORD.EXE", "wps.exe", "wpp.exe", "et.exe"]) {
		try { execFileSync("taskkill", ["/IM", proc, "/F"], { stdio: "ignore" }); } catch { /* 未运行 */ }
	}
	await sleep(1500);
	fs.rmSync(WS, { recursive: true, force: true });
}
fs.mkdirSync(WS, { recursive: true });

/* 启动应用 */
const killElectron = () => {
	const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
	const pids = new Set(
		out.split("\n").filter((l) => l.includes(`:${PORT}`) && l.includes("LISTENING"))
			.map((l) => l.trim().split(/\s+/).at(-1)).filter((p) => /^\d+$/.test(p)),
	);
	for (const pid of pids) execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
};
killElectron();
await sleep(1000);
const { ELECTRON_RUN_AS_NODE, ...cleanEnv } = process.env;
spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), [ROOT, `--remote-debugging-port=${PORT}`], { cwd: ROOT, env: cleanEnv, detached: true, stdio: "ignore" }).unref();
let ready = false;
for (let i = 0; i < 45; i++) {
	await sleep(2000);
	try {
		const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
		if (r.ok) { ready = true; break; }
	} catch { /* 未就绪 */ }
}
await sleep(6000);
ok("应用启动", ready);

const tabs = await CDP.List({ port: PORT });
const page = tabs.find((t) => t.type === "page");
const client = await CDP({ target: page.webSocketDebuggerUrl });
await client.Runtime.enable();
await client.Page.enable();

/* ① 文件卡渲染：确定性注入（不依赖模型） */
const m1 = await ev(`(function(){
	const d = document.createElement("div");
	d.className = "msg assistant";
	d.innerHTML = '<div class="body"></div>';
	const body = d.querySelector(".body");
	body.textContent = "文档已创建：C:\\\\p37-e2e\\\\fake\\\\报告.docx，请查收";
	document.body.appendChild(d);
	mountFileCards(body);
	const card = body.querySelector(".fcard");
	window.__p37probe = d;
	return JSON.stringify({
		n: body.querySelectorAll(".fcard").length,
		abs: card?.dataset.abs ?? null,
		name: card?.querySelector(".fcard-name")?.textContent ?? null,
		tag: card?.querySelector(".fcard-tag")?.textContent ?? null,
	});
})()`);
const r1 = JSON.parse(m1);
ok("文件卡渲染（绝对路径）", r1.n === 1 && r1.abs === "C:\\p37-e2e\\fake\\报告.docx" && r1.name === "报告.docx", JSON.stringify(r1));

/* 缺失态：异步 fileStat 后灰置 */
await sleep(800);
const missing = await ev(`window.__p37probe.querySelector(".fcard").classList.contains("missing")`);
ok("文件不存在灰置缺失态", missing === true);

/* ② zcode 私有标记兜底（docx 技能真实输出形状：::zcode-file-citation{...}） */
const m2 = await ev(`(function(){
	const d = document.createElement("div");
	d.className = "msg assistant";
	d.innerHTML = '<div class="body md"></div>';
	const body = d.querySelector(".body");
	body.innerHTML = "<p>Created ::zcode-file-citation{path=&quot;C:\\\\Users\\\\test\\\\out\\\\演示.pptx&quot; purpose=&quot;output&quot;}，完整绝对路径为 **C:/out/演示.pptx**。</p>";
	document.body.appendChild(d);
	mountFileCards(body);
	const cards = [...body.querySelectorAll(".fcard")];
	const leftover = body.textContent.includes("zcode") || body.textContent.includes("z:code") || body.textContent.includes("purpose=");
	window.__p37probe2 = d;
	return JSON.stringify({ n: cards.length, abs: cards[0]?.dataset.abs ?? null, leftover });
})()`);
const r2 = JSON.parse(m2);
ok("::zcode-file-citation 标记兜底成卡", r2.n === 2 && r2.abs === "C:\\Users\\test\\out\\演示.pptx" && r2.leftover === false, JSON.stringify(r2));
await ev(`window.__p37probe?.remove(); window.__p37probe2?.remove(); null`);

/* ③ 会话启动：model.input 透传（glm-5.3-flash 应含 image） */
await ev(`startSession(${JSON.stringify(WS.replace(/\\/g, "/"))}).then(() => null)`);
ok("会话已启动", await ev(`!!state.session`));
const mi = JSON.parse(await ev(`JSON.stringify(state.session?.model?.input ?? null)`));
ok("start 返回 model.input", Array.isArray(mi) && mi.includes("image"), `input=${JSON.stringify(mi)}`);

/* ④ 贴图无视觉提示：模拟纯文本模型标记 */
const warnOn = await ev(`(function(){
	state.session.model.input = ["text"];
	const before = document.querySelectorAll(".sysline").length;
	warnIfNoVision();
	const lines = [...document.querySelectorAll(".sysline")];
	return JSON.stringify({ grew: lines.length > before, text: lines.at(-1)?.textContent ?? "" });
})()`);
const r4 = JSON.parse(warnOn);
ok("纯文本模型贴图出警告", r4.grew && r4.text.includes("不支持图片"), r4.text.slice(0, 50));
const warnOff = await ev(`(function(){
	state.session.model.input = ["text", "image"];
	const before = document.querySelectorAll(".sysline").length;
	warnIfNoVision();
	return document.querySelectorAll(".sysline").length === before;
})()`);
ok("视觉模型贴图不警告", warnOff === true);

/* ⑤ 真实模型：产物落工作区 + 回报绝对路径 → 卡片出现 */
await ev(`sendText("请用 docx 技能在工作区 output/ 目录下创建 p37.docx（内容一句话即可，标题写 P37），完成后报告它的完整绝对路径。", [])`);
ok("真实产物回合结束", await waitSettled());
const m5 = JSON.parse(await ev(`(function(){
	const cards = [...document.querySelectorAll(".msg.assistant .fcard")];
	return JSON.stringify(cards.map((c) => c.dataset.abs));
})()`));
ok("真实回复中出现文件卡", m5.length >= 1, JSON.stringify(m5));
const realCard = m5.find((p) => /p37\.docx$/i.test(p ?? ""));
ok("卡片指向 p37.docx", !!realCard, realCard ?? "无");
const realAbs = realCard ? path.resolve(realCard.replace(/\//g, path.sep).replace(/^([A-Za-z]):/, (_x, d) => d + ":")) : null;
ok("产物文件真实存在", realAbs ? fs.existsSync(realAbs) : false, realAbs ?? "");
ok("产物收在工作区内", realAbs ? realAbs.toLowerCase().startsWith(WS.toLowerCase()) : false, realAbs ?? "");

/* ⑥ 右键菜单 */
const ctxR = JSON.parse(await ev(`(function(){
	const card = [...document.querySelectorAll(".msg.assistant .fcard")].pop();
	if (!card) return JSON.stringify({ ok: false });
	const r = card.getBoundingClientRect();
	card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: Math.round(r.x + 10), clientY: Math.round(r.y + 10) }));
	const menu = document.getElementById("ctx-menu");
	return JSON.stringify({ ok: true, visible: !menu.hidden, items: [...menu.querySelectorAll(".ctx-item")].map((b) => b.textContent) });
})()`));
ok("右键菜单弹出", ctxR.ok && ctxR.visible, JSON.stringify(ctxR.items ?? []));
ok("菜单含资源管理器定位/复制路径", (ctxR.items ?? []).join("|").includes("资源管理器") && (ctxR.items ?? []).join("|").includes("复制绝对路径"));
const copyBack = await ev(`(async function(){
	const item = [...document.querySelectorAll("#ctx-menu .ctx-item")].find((b) => b.textContent.includes("复制绝对路径"));
	item.click();
	await new Promise((r) => setTimeout(r, 300));
	try { return await navigator.clipboard.readText(); } catch { return "(clipboard-read-denied)"; }
})()`);
if (copyBack !== "(clipboard-read-denied)") ok("复制绝对路径生效", copyBack === m5.find(Boolean), copyBack);
else console.log("SKIP 复制绝对路径（剪贴板读取被拒，写动作已触发）");

/* ⑦ 左键打开不抛错（系统默认程序启动 Word/WPS 或失败提示，均不崩） */
const openOk = await ev(`(function(){
	const card = [...document.querySelectorAll(".msg.assistant .fcard")].pop();
	card.click();
	return true;
})()`);
ok("左键点击打开无异常", openOk === true);
await sleep(2000);

await shot("p37-fcard.png");
console.log(`\n===== P37 E2E：${total - fails}/${total} 通过 =====`);
process.exit(fails ? 1 : 0);
