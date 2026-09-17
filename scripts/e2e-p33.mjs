// E2E P33：自动更新器（本地 fixture 更新源全链路）+ diff 块级撤销
// 断言：更新源配置/检查到新版/下载到 ready 全链路（不真装）；hunk 渲染数量；撤销单块后其余块保留
import CDP from "chrome-remote-interface";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT33 = path.resolve(import.meta.dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = await (async () => {
	const tabs = await CDP.List({ port: 9333 });
	const page = tabs.find((t) => t.type === "page");
	return CDP({ target: page.webSocketDebuggerUrl });
})();
await client.Runtime.enable();
await client.Page.enable();
const ev = async (expr) => {
	const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.slice(0, 500));
	return r.result.value;
};
const shot = async (name) => {
	const r = await client.Page.captureScreenshot({ format: "png", fromSurface: true });
	fs.writeFileSync(name, Buffer.from(r.data, "base64"));
	console.log(`📸 ${name}`);
};
let total = 0;
let fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

/* ---- fixture 更新源：本地 HTTP 伺服 latest.yml + 假安装包（99.0.0） ---- */
const fakeExe = Buffer.from("fake-installer-payload-for-e2e-".repeat(40));
const sha512 = crypto.createHash("sha512").update(fakeExe).digest("base64");
const latestYml = `version: 99.0.0
files:
  - url: openpi-fake-99.0.0.exe
    sha512: ${sha512}
    size: ${fakeExe.length}
path: openpi-fake-99.0.0.exe
sha512: ${sha512}
releaseDate: '2026-09-13T00:00:00.000Z'`;
const server = http.createServer((req, res) => {
	if (req.url.includes("latest.yml")) {
		res.writeHead(200, { "content-type": "text/yaml" });
		res.end(latestYml);
	} else if (req.url.includes("openpi-fake-99.0.0.exe")) {
		res.writeHead(200, { "content-type": "application/octet-stream", "content-length": fakeExe.length });
		res.end(fakeExe);
	} else {
		res.writeHead(404);
		res.end("nf");
	}
});
await new Promise((r) => server.listen(9398, "127.0.0.1", r));

const cfgPath = path.join(os.homedir(), ".pi", "agent", "updater.json");
const devCfgPath = path.join(ROOT33, "dev-app-update.yml");
const cfgBefore = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath) : null;
const devBefore = fs.existsSync(devCfgPath) ? fs.readFileSync(devCfgPath) : null;
fs.writeFileSync(cfgPath, JSON.stringify({ provider: "generic", url: "http://127.0.0.1:9398/" }, null, 2));
// electron-updater 开发模式必须走工程根 dev-app-update.yml；结束前恢复用户/工程原配置
fs.writeFileSync(devCfgPath, `provider: generic\nurl: http://127.0.0.1:9398/\n`);

/* 会话前置：审核面板需要 state.session?.workspace（走 UI 同款 startSession 同步渲染层状态） */
await ev(`startSession(undefined).then(() => null)`);
await sleep(1500);

/* miniConfirm 自动确认（mini-modal 用 .hidden 属性显隐；dataset 防重） */
await client.Runtime.evaluate({ expression: `(() => {
	const mask = document.getElementById("mini-mask");
	if (!mask || window.__miniHooked) return;
	window.__miniHooked = true;
	new MutationObserver(() => {
		if (!mask.hidden && !mask.dataset.autoclicked) {
			mask.dataset.autoclicked = "1";
			setTimeout(() => document.getElementById("mini-ok")?.click(), 500);
		}
		if (mask.hidden && mask.dataset.autoclicked) delete mask.dataset.autoclicked;
	}).observe(mask, { attributes: true, attributeFilter: ["hidden"] });
})()`, returnByValue: true });

/* ---- 1. 自动更新全链路 ---- */
await ev(`document.getElementById("btn-settings")?.click(); null`);
await sleep(700);
ok("更新卡可见", await ev(`!!document.getElementById("update-card")`));
const appVer = JSON.parse(fs.readFileSync(path.join(ROOT33, "package.json"), "utf8")).version;
ok("当前版本显示", (await ev(`document.getElementById("update-line").textContent`)).includes(`v${appVer}`), `v${appVer}`);
ok("更新源已配置识别", await ev(`document.getElementById("update-hint").textContent.includes("已配置")`));
await ev(`document.getElementById("btn-update-check")?.click(); null`);
let found = false;
for (let i = 0; i < 20; i++) {
	await sleep(500);
	if ((await ev(`document.getElementById("update-line").textContent`)).includes("99.0.0")) { found = true; break; }
}
ok("检查到新版 99.0.0", found);
ok("下载按钮出现", await ev(`!document.getElementById("btn-update-download").hidden`));
await ev(`document.getElementById("btn-update-download")?.click(); null`);
let ready = false;
for (let i = 0; i < 30; i++) {
	await sleep(500);
	if (!(await ev(`document.getElementById("btn-update-install").hidden`))) { ready = true; break; }
}
ok("下载完成进入 ready（重启安装按钮出现）", ready);
await shot("p33-update.png");

/* ---- 2. diff 块级撤销 ---- */
const ws = path.join(os.homedir(), "openpi-workspace");
const f = path.join(ws, "p33-hunk.txt");
const base = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
fs.writeFileSync(f, base);
const git = (...a) => execFileSync("git", a, { cwd: ws, stdio: "pipe" });
git("add", "-A");
git("-c", "user.name=P33", "-c", "user.email=p33@e2e.local", "commit", "-m", "p33 baseline", "--allow-empty");
const modified = base.replace("line-1\n", "CHANGED-HUNK1\n").replace("line-11\n", "CHANGED-HUNK2\n"); // 相隔 9 行 → 两个独立 hunk
fs.writeFileSync(f, modified);

await ev(`showDock("review"); null`);
await sleep(800);
const rowIdx = await ev(`(async () => {
	const rows = [...document.querySelectorAll(".review-file")];
	const i = rows.findIndex((r) => r.querySelector(".path")?.textContent?.includes("p33-hunk.txt"));
	if (i < 0) return -1;
	rows[i].click();
	return i;
})()`);
ok("审核面板列出变更文件", rowIdx >= 0, `row=${rowIdx}`);
await sleep(700);
const hunkCount = await ev(`document.querySelectorAll(".hunk").length`);
ok("diff 渲染为 2 个 hunk 块", hunkCount === 2, `hunks=${hunkCount}`);

await ev(`document.querySelector('.hunk[data-h="0"] .hunk-revert')?.click(); null`); // 自动确认钩子处理
let reverted = false;
for (let i = 0; i < 20; i++) {
	await sleep(500);
	if (!fs.readFileSync(f, "utf8").includes("CHANGED-HUNK1")) { reverted = true; break; }
}
ok("第 1 块已撤销（line-1 复原）", reverted);
ok("第 2 块保留（改动仍在）", fs.readFileSync(f, "utf8").includes("CHANGED-HUNK2"));
ok("其余行未受影响", fs.readFileSync(f, "utf8").includes("line-6") && fs.readFileSync(f, "utf8").includes("line-12"));
await ev(`showDock("review"); null`);
await sleep(500);
await shot("p33-hunks.png");

server.close();
// P70：原样恢复现场，测试不得把用户更新源强改成本机端口。
if (cfgBefore) fs.writeFileSync(cfgPath, cfgBefore); else fs.rmSync(cfgPath, { force: true });
if (devBefore) fs.writeFileSync(devCfgPath, devBefore); else fs.rmSync(devCfgPath, { force: true });
console.log(fails ? `\n${total - fails}/${total} 通过` : `\n全部通过 ✓ ${total}/${total}`);
process.exit(fails ? 1 : 0);
