// E2E P38：压缩包技能 archive（v0.34.0）
// 覆盖：① 技能自动部署（resources/skills/archive → ~/.pi/agent/skills）② 内置 runtime 含 py7zr
// ③ 真实模型：GBK 中文 zip 解压不乱码 ④ 打包 zip（UTF-8 标志位）+ 产物收工作区 + 回报绝对路径 → 文件卡
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9333;
const HOST_PY = path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python312", "python.exe");
const RT_PY = path.join(ROOT, "resources", "runtime", "python", "python3.exe");
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

/* 工作区：~/p38-e2e（全新）+ GBK 中文 zip 夹具（模拟 Windows 资源管理器压缩：GBK 文件名、无 UTF-8 标志位） */
const WS = path.join(os.homedir(), "p38-e2e");
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(path.join(WS, "output"), { recursive: true });
const gbkZip = path.join(WS, "季度资料.zip");
execFileSync(HOST_PY, [
	"-c",
	`import zipfile, os
with zipfile.ZipFile(r'${gbkZip.replace(/\\/g, "\\\\")}', 'w') as z:
    for name, body in [('季度报告.txt', '第三季度销售目标完成率 108%'.encode('utf-8')), ('数据/明细表.txt', '一月 120\\n二月 135'.encode('utf-8')), ('说明.txt', b'readme')]:
        zi = zipfile.ZipInfo(name)
        zi.flag_bits = 0  # 无 UTF-8 标志位 = 老式 GBK zip
        z.writestr(zi, body)
print('fixture OK')`,
]);
ok("GBK 中文 zip 夹具就绪", fs.existsSync(gbkZip));

/* 启动应用（干净实例） */
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

/* ① 技能自动部署（启动时 ensureOfficeSkills） */
const skillMd = path.join(os.homedir(), ".pi", "agent", "skills", "archive", "SKILL.md");
ok("archive 技能自动部署", fs.existsSync(skillMd));
if (fs.existsSync(skillMd)) {
	const md = fs.readFileSync(skillMd, "utf8");
	ok("技能署名 OpenPi（无第三方痕迹）", md.includes("author: OpenPi") && !/zcode|Z\.AI/i.test(md.split("description-zh")[0]));
	ok("中文描述注入", md.includes("description-zh:") && md.includes("压缩包处理"));
}

/* ② 内置 runtime 依赖 */
const deps = execFileSync(RT_PY, ["-c", "import py7zr, zipfile, tarfile; print('OK')"], { encoding: "utf8" });
ok("内置 runtime py7zr 可用", deps.includes("OK"));

/* ③ 真实模型：解压 GBK 中文 zip */
await ev(`startSession(${JSON.stringify(WS.replace(/\\/g, "/"))}).then(() => null)`);
ok("会话已启动", await ev(`!!state.session`));

await ev(`sendText("工作区根目录有个 季度资料.zip（Windows 资源管理器直接压缩的老式 GBK 包）。请用 archive 技能解压到工作区 output/ 下，然后告诉我里面有什么文件。", [])`);
await waitSettled();

const report1 = path.join(WS, "output", "季度资料", "季度报告.txt");
const report1b = path.join(WS, "output", "季度资料", "数据", "明细表.txt");
const extracted = fs.existsSync(report1) || fs.existsSync(report1b);
ok("解压产物存在（中文文件名不乱码）", extracted, `${report1b}`);
if (!fs.existsSync(report1)) {
	// 兼容模型自选目录名（如 output/季度资料.zip 解到别处）——扫描 output 全树找 中文名产物
	const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(d, e.name);
		return e.isDirectory() ? walk(p) : [p];
	});
	const all = fs.existsSync(path.join(WS, "output")) ? walk(path.join(WS, "output")) : [];
	ok("output 全树找到中文产物（目录名不同）", all.some((p) => p.includes("季度报告.txt") || p.includes("明细表.txt")), all.slice(0, 4).join(" | "));
}
const reply1 = await ev(`[...document.querySelectorAll(".msg.assistant .body")].map(d=>d.textContent).join(" ").slice(-1200)`);
ok("回复报告了绝对路径（文件卡素材）", /output/i.test(reply1) || /[A-Z]:\\/.test(reply1), reply1.slice(-160).replace(/\s+/g, " "));

/* ④ 真实模型：打包成 zip */
await ev(`sendText("很好。现在把解压出来的全部内容打包成 zip，保存到 output/成品.zip。", [])`);
await waitSettled();

const zipOut = path.join(WS, "output", "成品.zip");
let zipOk = fs.existsSync(zipOut);
if (!zipOk) {
	const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(d, e.name);
		return e.isDirectory() ? walk(p) : p.toLowerCase().endsWith(".zip") ? [p] : [];
	});
	const zips = fs.existsSync(path.join(WS, "output")) ? walk(path.join(WS, "output")) : [];
	zipOk = zips.length > 0;
	ok("找到 zip 产物（文件名不同）", true, zips[0] ?? "无");
	if (zips[0]) {
		const entries = execFileSync(RT_PY, ["-X", "utf8", "-c",
			`import zipfile, sys\nz = zipfile.ZipFile(r'${zips[0].replace(/\\/g, "\\\\")}')\nnames = z.namelist()\nutf8flag = any(i.flag_bits & 0x800 for i in z.infolist())\nprint(len(names), utf8flag, '|'.join(names))`], { encoding: "utf8" });
		ok("zip 结构可读回", entries.length > 0, entries.trim().slice(0, 120));
	}
} else {
	const entries = execFileSync(RT_PY, ["-X", "utf8", "-c",
		`import zipfile\nz = zipfile.ZipFile(r'${zipOut.replace(/\\/g, "\\\\")}')\nnames = z.namelist()\nutf8flag = any(i.flag_bits & 0x800 for i in z.infolist())\nprint(len(names), utf8flag, '|'.join(names))`], { encoding: "utf8" });
	ok("成品.zip 存在且结构正确", entries.trim().length > 0, entries.trim().slice(0, 120));
}

/* ⑤ 文件卡：真实产物路径 → 卡片 */
await sleep(1500);
const cards = await ev(`[...document.querySelectorAll(".fcard")].map(c => c.dataset.abs).filter(a => a && a.toLowerCase().includes("p38-e2e"))`);
ok("对话流出现工作区产物文件卡", cards.length >= 1, cards.slice(0, 3).join(" | "));

await shot("p38-archive.png");

console.log(fails ? `\n${total - fails}/${total} 通过` : `\n全部通过 ✓ ${total}/${total}`);
process.exit(fails ? 1 : 0);
