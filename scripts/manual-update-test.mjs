// 真机升级验证（一次性）：已装 0.32.0 → 本地更新源 0.33.1 → 检查/下载/安装 → 复核版本
// 前置：发布源 :9355 在跑（server.bat）、已装版无实例、node scripts/manual-update-test.mjs
import CDP from "chrome-remote-interface";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import asar from "@electron/asar";

const INSTALLED = "C:/Users/86321/AppData/Local/Programs/openpi-desktop/OpenPi Desktop.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (name, cond, extra = "") => {
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

const verBefore = JSON.parse(asar.extractFile("C:/Users/86321/AppData/Local/Programs/openpi-desktop/resources/app.asar", "package.json").toString()).version;
ok(`已装版本基线`, verBefore === "0.32.0", `v${verBefore}`);

console.log("启动已装版（remote-debugging-port=9334）…");
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE; // 工具链环境变量会把 exe 打回 node 模式（bad option）
for (const k of Object.keys(childEnv)) if (/proxy/i.test(k)) delete childEnv[k]; // 模拟真实用户双击环境（无 shell 代理变量）
const child = spawn(INSTALLED, ["--remote-debugging-port=9334"], { detached: true, stdio: "ignore", env: childEnv });
child.unref();
await sleep(6000);

let client = null;
for (let i = 0; i < 10 && !client; i++) {
	try {
		const tabs = await CDP.List({ port: 9334 });
		const page = tabs.find((t) => t.type === "page");
		client = await CDP({ target: page.webSocketDebuggerUrl });
	} catch { await sleep(1500); }
}
if (!client) { console.error("✘ CDP 连不上 9334"); process.exit(1); }
await client.Runtime.enable();
const ev = async (expr) => {
	const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.slice(0, 300));
	return r.result.value;
};

// 设置页 → 更新卡
await ev(`document.getElementById("btn-settings")?.click(); null`);
await sleep(800);
ok("更新卡可见", await ev(`!!document.getElementById("update-card")`));
ok("当前版本显示", (await ev(`document.getElementById("update-line").textContent`)).includes(`v${verBefore}`));
ok("更新源已配置", (await ev(`document.getElementById("update-hint").textContent`)).includes("已配置"));

// 检查更新 → available 0.33.1
await ev(`document.getElementById("btn-update-check")?.click(); null`);
let found = false;
for (let i = 0; i < 20; i++) {
	await sleep(1000);
	const line = await ev(`document.getElementById("update-line").textContent`);
	if (line.includes("0.33.1")) { found = true; break; }
}
ok("检查更新发现 0.33.1", found, `line=${await ev(`document.getElementById("update-line").textContent`)}`);
ok("下载按钮出现", await ev(`!document.getElementById("btn-update-download").hidden`));

// 下载（244MB 本地环回，秒级~几十秒）→ ready
await ev(`document.getElementById("btn-update-download")?.click(); null`);
let ready = false;
for (let i = 0; i < 120; i++) {
	await sleep(1000);
	if (!(await ev(`document.getElementById("btn-update-install")?.hidden ?? true`))) { ready = true; break; }
}
ok("下载完成、安装按钮出现", ready);

// 安装（quitAndInstall，应用退出 → CDP 断连属预期）
console.log("触发安装（应用将退出并静默升级）…");
try { await ev(`document.getElementById("btn-update-install")?.click(); null`); } catch { /* 断连预期 */ }
await sleep(40000); // NSIS 静默安装含文件替换，读早了会 ENOENT

// 复核：已装版本
const verAfter = JSON.parse(asar.extractFile("C:/Users/86321/AppData/Local/Programs/openpi-desktop/resources/app.asar", "package.json").toString()).version;
ok("升级后版本 = 0.33.1", verAfter === "0.33.1", `v${verAfter}`);

// 复核：新版本能正常启动
try { execSync(`taskkill /im "OpenPi Desktop.exe" /f 2>nul`, { shell: "cmd.exe" }); } catch { /* 没跑就跳过 */ }
await sleep(2000);
spawn(INSTALLED, ["--remote-debugging-port=9334"], { detached: true, stdio: "ignore", env: childEnv }).unref();
await sleep(6000);
let ok2 = false;
try {
	const tabs = await CDP.List({ port: 9334 });
	const page = tabs.find((t) => t.type === "page");
	const c2 = await CDP({ target: page.webContentsId ?? page.webSocketDebuggerUrl });
	await c2.Runtime.enable();
	await sleep(2500);
	const v = await c2.Runtime.evaluate({ expression: `document.body.textContent.includes("v0.33.1") || document.getElementById("update-line")?.textContent.includes("v0.33.1")`, returnByValue: true });
	ok2 = v.result.value === true;
	await c2.Runtime.evaluate(`document.getElementById("btn-settings")?.click(); null`).catch(() => {});
	await sleep(800);
	const line = await c2.Runtime.evaluate({ expression: `document.getElementById("update-line")?.textContent ?? ""`, returnByValue: true });
	console.log(`  更新卡显示: ${line.result.value}`);
	await client_screenshot(c2, "manual-update-done.png");
	await c2.close();
} catch (e) { ok2 = false; console.log(`  复核异常: ${e.message.slice(0, 120)}`); }
ok("升级后应用正常启动并显示 v0.33.1", ok2);

async function client_screenshot(c, name) {
	try {
		const r = await c.Page.captureScreenshot({ format: "png", fromSurface: true });
		fs.writeFileSync(name, Buffer.from(r.data, "base64"));
		console.log(`📸 ${name}`);
	} catch { /* Page 域未开则跳过 */ }
}

console.log(fails ? `\n${6 + 4 - fails - 2}/${10} 通过（粗计）` : "\n全部通过 ✓ 真实更新链路走通");
process.exit(fails ? 1 : 0);
