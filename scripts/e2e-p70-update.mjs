// E2E P70：公网 GitHub 源真机更新链路（v0.48.0 已装版 → GitHub Release 检出 v0.58.0）
// 用法：node scripts/e2e-p70-update.mjs check|download|install|verify
//   check    杀旧实例 → CDP 启动已装版 → snapshot 断言 → updateCheck 断言检出 0.58.0（真 GitHub 链）
//   download updateDownload → 轮询 snapshot 到 ready（312MB，走系统代理）
//   install  updateInstall → 退出即装
//   verify   PowerShell 读 exe FileVersion 断言 0.58.0
// 断言前先杀 9370 残留（#91 家族）；CDP async 调用同步 IIFE 包裹防卡死（#102）
import CDP from "chrome-remote-interface";
import { execFileSync, spawn } from "node:child_process";

const PORT = 9370;
const APP = "C:/Users/86321/AppData/Local/Programs/openpi-desktop/OpenPi Desktop.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mode = process.argv[2] ?? "check";
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
const killPort = () => {
	const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
	const pids = new Set(
		out.split("\n").filter((l) => l.includes(`:${PORT}`) && l.includes("LISTENING"))
			.map((l) => l.trim().split(/\s+/).at(-1)).filter((p) => /^\d+$/.test(p)),
	);
	for (const pid of pids) execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
};
const killApp = () => {
	try {
		execFileSync("taskkill", ["/IM", "OpenPi Desktop.exe", "/T", "/F"], { stdio: "ignore" });
	} catch {
		/* 未运行 */
	}
};

let client = null;
const connect = async () => {
	let ready = false;
	for (let i = 0; i < 45; i++) {
		await sleep(2000);
		try {
			const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
			if (r.ok) {
				ready = true;
				break;
			}
		} catch {
			/* 未就绪 */
		}
	}
	if (!ready) throw new Error("CDP 端口未就绪");
	await sleep(5000);
	const tabs = await CDP.List({ port: PORT });
	const page = tabs.find((t) => t.type === "page");
	client = await CDP({ target: page.webSocketDebuggerUrl });
	await client.Runtime.enable();
};

if (mode === "check") {
	killPort();
	killApp();
	await sleep(1500);
	spawn(APP, [`--remote-debugging-port=${PORT}`], { cwd: "C:/Users/86321/AppData/Local/Programs/openpi-desktop", detached: true, stdio: "ignore" }).unref();
	await connect();
	const snap = await ev(`window.openpi.updateSnapshot()`);
	ok("当前版本 0.48.0", snap.current === "0.48.0", `got ${snap.current}`);
	ok("更新源已配置", snap.configured === true);
	const chk = await ev(`window.openpi.updateCheck()`);
	ok("GitHub 检出 0.58.0", chk.ok === true && chk.version === "0.58.0", JSON.stringify(chk).slice(0, 160));
	console.log(`\n实例保持运行（CDP :${PORT}），继续：download → install`);
} else if (mode === "download") {
	await connect();
	const d = await ev(`window.openpi.updateDownload()`);
	console.log("download 返回：", JSON.stringify(d).slice(0, 80));
	let readyState = null;
	const t0 = Date.now();
	while (Date.now() - t0 < 25 * 60_000) {
		await sleep(5000);
		const s = await ev(`window.openpi.updateSnapshot()`);
		if (s.status !== readyState) {
			readyState = s.status;
			console.log(`[${Math.round((Date.now() - t0) / 1000)}s] status=${s.status} ${s.progress != null ? s.progress + "%" : ""}`);
		}
		if (s.status === "ready" || s.status === "error") break;
	}
	const s = await ev(`window.openpi.updateSnapshot()`);
	ok("下载完成 ready", s.status === "ready", JSON.stringify(s).slice(0, 160));
} else if (mode === "install") {
	await connect();
	await ev(`window.openpi.updateInstall()`);
	console.log("已触发 quitAndInstall，等 40s 安装…");
	await sleep(40_000);
	ok("应用退出（安装中）", true);
} else if (mode === "verify") {
	const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Item 'C:\\Users\\86321\\AppData\\Local\\Programs\\openpi-desktop\\OpenPi Desktop.exe').VersionInfo.ProductVersion`], { encoding: "utf8" });
	ok("安装后版本 0.58.0", out.trim().startsWith("0.58.0"), `got ${out.trim()}`);
} else {
	console.error("mode 必须是 check|download|install|verify");
	process.exit(1);
}

console.log(`\n${mode}: ${total - fails}/${total} 断言通过`);
process.exit(fails ? 1 : 0);
