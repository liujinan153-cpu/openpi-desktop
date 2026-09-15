// E2E P38.5：视觉链路修复（贴图 400 排查）
// 修复点（src/main/agent-host.mjs #sanitizeVisionPayload）：
//   ① 空 data 图片剔除（智谱 1214「.file必须传入…」）
//   ② 空文本+图片时补占位文本（智谱 1210「API 调用参数有误」，实测 [text(""),image] 被拒、[image] 单独发正常）
// 方法：沙箱 agent 目录（PI_CODING_AGENT_DIR）+ 本地 echo server 抓包 + CDP 走真实 renderer→IPC→SDK 链路
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9334;
const ECHO = 9997;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0, fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

/* —— echo server：抓智谱格式请求 —— */
const bodies = [];
const echo = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		bodies.push(Buffer.concat(chunks).toString("utf8"));
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.write('data: {"id":"e","choices":[{"delta":{"content":"ok"},"index":0,"finish_reason":"stop"}]}\n\n');
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
echo.listen(ECHO, "127.0.0.1");

/* —— 沙箱 agent 目录：zhipu baseUrl → echo —— */
const agentDir = path.join(os.tmpdir(), "p385-vision-agent");
fs.rmSync(agentDir, { recursive: true, force: true });
fs.mkdirSync(agentDir, { recursive: true });
const userModels = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "models.json"), "utf8"));
userModels.providers.zhipu.baseUrl = `http://127.0.0.1:${ECHO}/v1`;
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(userModels));
const authSrc = path.join(os.homedir(), ".pi", "agent", "auth.json");
if (fs.existsSync(authSrc)) fs.copyFileSync(authSrc, path.join(agentDir, "auth.json"));

/* —— 启动应用（dev，剥 proxy） —— */
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
const ws = path.join(os.homedir(), "p385-vision-e2e");
fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(ws, { recursive: true });
await ev(`startSession(${JSON.stringify(ws.replace(/\\/g, "/"))}).then(() => null)`);
await sleep(1500);
const mi = JSON.parse(await ev(`window.openpi.setModel("zhipu","glm-5.3-flash").then(r=>JSON.stringify(r))`));
ok("切到 zhipu/glm-5.3-flash", mi.id === "glm-5.3-flash", JSON.stringify(mi));

/* 真图（小截图，135KB） */
const imgPath = path.join(os.homedir(), "Downloads", "ScreenShot_2026-09-14_021924_076.png");
const b64 = fs.readFileSync(imgPath, "base64");
ok("测试图片就绪", b64.length > 100000, `base64=${b64.length}`);

const waitCapture = async (n0) => {
	for (let i = 0; i < 40; i++) { await sleep(1000); if (bodies.length > n0) return; }
	throw new Error("echo 未收到请求");
};
const firstUserContent = (idx) => {
	let found = null;
	for (const b of bodies.slice(idx)) {
		try {
			const j = JSON.parse(b);
			const users = j.messages.filter((m) => m.role === "user" && Array.isArray(m.content));
			if (users.length) found = users[users.length - 1].content; // 取最后一条 user（请求含全量历史）
		} catch { /* retry 流量非 JSON */ }
	}
	return found;
};

/* 场景① 空文本+图片（复刻用户贴图）——修复后应发占位文本 */
const n0 = bodies.length;
await ev(`window.openpi.prompt("", [{ type:"image", data: ${JSON.stringify(b64)}, mimeType:"image/png" }]).then(()=>"ok").catch(e=>"ERR:"+e.message)`);
await waitCapture(n0);
let c = firstUserContent(n0);
ok("场景① 请求含图片 part", !!c?.some((p) => p.image_url?.url));
const emptyText = c?.find((p) => p.type === "text" && p.text === "");
ok("场景① 无空文本 part（1210 修复）", !!c && !emptyText, JSON.stringify(c?.map((p) => p.type + ":" + (p.text ?? "img").slice(0, 12))));
ok("场景① 图片 base64 非空", !!c?.some((p) => (p.image_url?.url ?? "").split("base64,")[1]?.length > 0));

/* 场景② 空文本+空 data 图片 —— 应整包不发（1214 防护） */
const n1 = bodies.length;
await ev(`window.openpi.prompt("", [{ type:"image", data:"", mimeType:"image/png" }]).then(()=>"ok").catch(e=>"ERR:"+e.message)`);
await sleep(6000);
ok("场景② 空 data 图片整包不发", bodies.length === n1, `新增请求=${bodies.length - n1}`);

/* 场景③ 带文字+图片 —— 文本保留 */
const n2 = bodies.length;
await ev(`window.openpi.prompt("这是什么？", [{ type:"image", data: ${JSON.stringify(b64)}, mimeType:"image/png" }]).then(()=>"ok").catch(e=>"ERR:"+e.message)`);
await waitCapture(n2);
c = firstUserContent(n2);
ok("场景③ 文本保留", !!c?.some((p) => p.type === "text" && p.text === "这是什么？"));
ok("场景③ 图片在列", !!c?.some((p) => p.image_url?.url));

/* 场景④ 贴图自动压缩（P38.6）：4000x3000 大图 → jpeg ≤2048px */
let c4 = await ev(`(async () => {
	const cv = document.createElement("canvas");
	cv.width = 4000; cv.height = 3000;
	const ctx = cv.getContext("2d");
	ctx.fillStyle = "#3a7"; ctx.fillRect(0, 0, 4000, 3000);
	ctx.fillStyle = "#fff"; for (let i = 0; i < 600; i++) ctx.fillRect(i * 6, i * 5, 3, 3);
	const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
	const img = await fileToImage(new File([blob], "big.png", { type: "image/png" }));
	const im2 = new Image();
	await new Promise((res, rej) => { im2.onload = res; im2.onerror = rej; im2.src = "data:" + img.mimeType + ";base64," + img.data; });
	return { mime: img.mimeType, len: img.data.length, orig: blob.size, w: im2.naturalWidth, h: im2.naturalHeight };
})()`);
ok("场景④ 大图压缩为 jpeg", c4?.mime === "image/jpeg", JSON.stringify({ mime: c4?.mime }));
ok("场景④ 体积明显缩小", c4 && c4.len < c4.orig / 2, `${(c4.orig / 1024).toFixed(0)}KB → ${(c4.len / 1024).toFixed(0)}KB`);
ok("场景④ 最长边 ≤2048", c4 && Math.max(c4.w, c4.h) <= 2048, `${c4?.w}x${c4?.h}`);

/* 场景⑤ 小图原样保留（不误伤 PNG 截图清晰度） */
const c5 = await ev(`(async () => {
	const cv = document.createElement("canvas");
	cv.width = 800; cv.height = 600;
	cv.getContext("2d").fillRect(0, 0, 800, 600);
	const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
	const img = await fileToImage(new File([blob], "small.png", { type: "image/png" }));
	return { mime: img.mimeType };
})()`);
ok("场景⑤ 小图保留 png 原样", c5?.mime === "image/png", JSON.stringify(c5 ?? {}));

/* 场景⑥ 上下文仪表（P38.8）：显式数字 + 1M 窗口生效 */
const c6 = await ev(`(() => {
	updateCtxBar({ input: 50000, output: 100, cacheRead: 0, cacheWrite: 0 });
	const el = document.getElementById("ctx-text");
	const bar = document.getElementById("ctx-bar");
	return { text: el?.textContent ?? "", width: bar?.style.width ?? "", has: !!el && !!bar };
})()`);
ok("场景⑥ 仪表元素存在", c6?.has === true, JSON.stringify(c6 ?? {}));
ok("场景⑥ 显示已用/总量/百分比", /上下文 50\.0k \/ 1M · 5%/.test(c6?.text ?? ""), c6?.text);
ok("场景⑥ 进度条宽度生效", c6?.width === "5%", c6?.width);

/* 场景⑦ 模型上下文标注完整性（P38.9）：全列表都有窗口值，下拉显式展示 */
const c7 = await ev(`({
	missing: state.models.filter((m) => !m.contextWindow).map((m) => m.provider + "/" + m.id),
	opts: [...document.querySelectorAll("#model-select option")].map((o) => o.textContent),
})`);
ok("场景⑦ 全部模型已标上下文窗口", c7.missing.length === 0, JSON.stringify(c7.missing));
ok("场景⑦ 下拉显示 1M 格式", (c7.opts ?? []).some((t) => /glm-5\.3-flash · 1M$/.test(t)), JSON.stringify((c7.opts ?? []).slice(-3)));

echo.close();
const shotR = await client.Page.captureScreenshot({ format: "png", fromSurface: true }).catch(() => null);
if (shotR) fs.writeFileSync("e2e/p385-vision.png", Buffer.from(shotR.data, "base64"));
try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 无进程 */ }
console.log("📸 e2e/p385-vision.png");
console.log(fails ? `\n${total - fails}/${total} 通过` : `\n全部通过 ✓ ${total}/${total}`);
process.exit(fails ? 1 : 0);
