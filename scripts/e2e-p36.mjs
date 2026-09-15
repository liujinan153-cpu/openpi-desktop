// E2E P36：办公技能安装即用（内置 Python 运行时）
// 前置：resources/runtime/python 已由 scripts/prepare-python-runtime.mjs 构建
// 关键：应用启动时从 PATH 中摘除系统 Python（模拟干净机器），验证内置 runtime 兜底可用
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
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.slice(0, 400));
	return r.result.value;
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
const PY = path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python312", "python.exe");
const pyVal = (code) => execFileSync(PY, ["-X", "utf8", "-c", code], { encoding: "utf8", timeout: 30000 }).replace(/\r/g, "").trim();

/* 应用自检：内置 runtime 是否就绪 */
const rtPy = path.join(ROOT, "resources", "runtime", "python", "python3.exe");
ok("内置 Python 运行时存在", fs.existsSync(rtPy));
if (!fs.existsSync(rtPy)) {
	console.error("先跑 scripts/prepare-python-runtime.mjs");
	process.exit(2);
}

/* 干净机启动：PATH 摘除一切 Python 段 */
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
cleanEnv.PATH = cleanEnv.PATH
	.split(";")
	.filter((seg) => seg && !/python/i.test(seg))
	.join(";");
const noPy = !cleanEnv.PATH.toLowerCase().includes("python");
ok("启动环境已摘除系统 Python", noPy);
const child = spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), [ROOT, `--remote-debugging-port=${PORT}`], { cwd: ROOT, env: cleanEnv, detached: true, stdio: "ignore" }).unref();
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

/* 工作区 + 让 AI 用 bash 验证 python3 可用性 + 生成一份 docx（真实链路） */
const ws = path.join(os.homedir(), "p36-e2e");
fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(ws, { recursive: true });
await ev(`startSession(${JSON.stringify(ws.replace(/\\/g, "/"))}).then(() => null)`);
await sleep(2000);
ok("会话已启动", await ev(`!!state.session`));

await ev(`sendText("请在 bash 里执行：which python3 && python3 --version && python3 -c \\"import docx, openpyxl, pptx, pypdf, reportlab, fitz; print('DEPS-OK')\\"，把输出原样告诉我。", [])`);
await waitSettled();
const sysText = await ev(`[...document.querySelectorAll(".msg")].map((e) => e.textContent).join(" ")`);
ok("python3 在 PATH 且来自内置 runtime", /resources[\\/]runtime[\\/]python/i.test(sysText) || !/AppData[\\/]Local[\\/]Programs[\\/]Python/i.test(sysText), "(路径断言)");
ok("依赖自检 DEPS-OK", sysText.includes("DEPS-OK"));

/* 真实生成链路：docx（P37 起产物规范引导进 output/ 子目录，两处都认） */
await ev(`sendText("请用 docx 技能创建 Word 文档 p36.docx：标题《开箱即用验证》，一段正文。生成后确认文件在工作区。", [])`);
await waitSettled();
const docxPath = [path.join(ws, "p36.docx"), path.join(ws, "output", "p36.docx")].find((p) => fs.existsSync(p));
ok("p36.docx 已生成", !!docxPath, docxPath ?? "未找到");
if (docxPath) {
	const n = Number(pyVal(`from docx import Document; d=Document(r'${docxPath.replace(/\\/g, "/")}'); print(len([p for p in d.paragraphs if p.text.strip()]))`));
	ok("宿主 python-docx 读回（跨运行时互认）", n >= 2, `段落=${n}`);
}
const shotR = await client.Page.captureScreenshot({ format: "png", fromSurface: true });
fs.writeFileSync("p36-runtime.png", Buffer.from(shotR.data, "base64"));
console.log("📸 p36-runtime.png");

console.log(fails ? `\n${total - fails}/${total} 通过` : `\n全部通过 ✓ ${total}/${total}`);
process.exit(fails ? 1 : 0);
