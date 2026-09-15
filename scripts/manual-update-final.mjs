// 终验（一次性）：0.33.1（带 app-update.yml 的真实安装包）→ 99.0.0 fixture 全链路（检查→下载→ready）
// 造 fixture：fake exe + 匹配 sha512 的 latest.yml → 恢复现场
import CDP from "chrome-remote-interface";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REL = "E:/pi2/openpi-releases";
let fails = 0;
const ok = (n, c, e = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${e ? "  " + e : ""}`); if (!c) fails++; };

// 1) fixture
const fake = crypto.randomBytes(4096);
const sha512 = crypto.createHash("sha512").update(fake).digest("base64");
const fakeName = "OpenPi Desktop Setup 99.0.0.exe";
fs.writeFileSync(`${REL}/${fakeName}`, fake);
const bak = fs.readFileSync(`${REL}/latest.yml`, "utf8");
fs.writeFileSync(`${REL}/latest.yml`, `version: 99.0.0\nfiles:\n  - url: ${fakeName}\n    sha512: ${sha512}\n    size: ${fake.length}\npath: ${fakeName}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'`);
console.log("fixture 99.0.0 就位（原 latest.yml 已备份）");
try {
	// 2) 启动已装 0.33.1
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	for (const k of Object.keys(env)) if (/proxy/i.test(k)) delete env[k];
	spawn("C:/Users/86321/AppData/Local/Programs/openpi-desktop/OpenPi Desktop.exe", ["--remote-debugging-port=9334"], { detached: true, stdio: "ignore", env }).unref();
	await sleep(7000);
	const tabs = await CDP.List({ port: 9334 });
	const c = await CDP({ target: tabs.find((t) => t.type === "page").webSocketDebuggerUrl });
	await c.Runtime.enable();
	const ev = async (x) => {
		const r = await c.Runtime.evaluate({ expression: x, returnByValue: true, userGesture: true, awaitPromise: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.slice(0, 200));
		return r.result.value;
	};
	await ev(`document.getElementById("btn-settings")?.click(); null`);
	await sleep(800);
	ok("当前版本显示 v0.33.1", (await ev(`document.getElementById("update-line").textContent`)).includes("v0.33.1"));
	await ev(`document.getElementById("btn-update-check")?.click(); null`);
	let found = false;
	for (let i = 0; i < 15; i++) { await sleep(1000); if ((await ev(`document.getElementById("update-line").textContent`)).includes("99.0.0")) { found = true; break; } }
	ok("发现 99.0.0（checkForUpdates 走通）", found);
	await ev(`document.getElementById("btn-update-download")?.click(); null`);
	let ready = false;
	for (let i = 0; i < 60; i++) { await sleep(1000); if (!(await ev(`document.getElementById("btn-update-install")?.hidden ?? true`))) { ready = true; break; } }
	ok("下载完成进入 ready（app-update.yml 在包内生效）", ready);
	// 不点安装，恢复现场
	await c.close();
} catch (e) { ok("全链路", false, e.message.slice(0, 150)); }
fs.writeFileSync(`${REL}/latest.yml`, bak);
fs.rmSync(`${REL}/${fakeName}`, { force: true });
// 清 electron-updater 下载缓存（不清则下次启动读缓存的 ready 状态，报「新版已下载 v99.0.0」）
fs.rmSync(process.env.LOCALAPPDATA + "/openpi-desktop-updater", { recursive: true, force: true });
console.log("已恢复 latest.yml、发布目录与下载缓存");
console.log(fails ? "\n有失败项" : "\n全部通过 ✓ 0.33.1 → 下一版更新链路完整");
process.exit(fails ? 1 : 0);
