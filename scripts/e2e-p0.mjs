/**
 * P0 E2E：验证右侧 Dock（审核/预览标签）+ Codex 式审核面板
 * 前置：先启动 electron（--remote-debugging-port=9333），并保证工作区是 git 仓库
 */
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const PORT = 9333;
const APP = "E:/pi2/openpi-desktop";

const connect = async () => {
	const tabs = await CDP.List({ port: PORT });
	const page = tabs.find((t) => t.type === "page");
	if (!page) throw new Error("no page target");
	return CDP({ target: page.webSocketDebuggerUrl });
};

const ev = (client, expr) =>
	client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => {
		if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description ?? "").slice(0, 400));
		return r.result.value;
	});

const shot = async (client, name) => {
	const r = await client.Page.captureScreenshot({ format: "png", fromSurface: true });
	fs.writeFileSync(`${APP}/p0-${name}.png`, Buffer.from(r.data, "base64"));
	console.log(`📸 p0-${name}.png`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
	const client = await connect();
	await client.Runtime.enable();
	await client.Page.enable();

	// ---- 0. 冒烟：Dock DOM 存在，默认隐藏 ----
	console.log("== 0. 冒烟 ==");
	console.log("dock存在:", await ev(client, "!!document.getElementById('dock')"));
	console.log("dock默认隐藏:", await ev(client, "document.getElementById('dock').hidden"));

	// ---- 1. 在工作区造两个变更（1 个已跟踪修改 + 1 个新文件），打开审核面板 ----
	console.log("== 1. 造变更 + 打开审核 ==");
	const ws = await ev(client, "state.session?.workspace");
	console.log("工作区:", ws);
	if (!ws) throw new Error("无工作区");
	// 确保 git 仓库 + 本地身份（不污染全局配置）
	const g = (args, opts = {}) => execFileSync("git", args, { cwd: ws, stdio: "pipe", ...opts });
	try { g(["rev-parse", "--git-dir"]); } catch { g(["init"]); g(["checkout", "-b", "main"]); }
	try { g(["config", "user.email"]); } catch { g(["config", "user.email", "e2e@openpi.local"]); g(["config", "user.name", "P0 E2E"]); }
	fs.writeFileSync(`${ws}/p0-tracked.txt`, "line1\nline2\nline3\n");
	try {
		execFileSync("git", ["add", "p0-tracked.txt"], { cwd: ws });
		execFileSync("git", ["commit", "-m", "p0-e2e base"], { cwd: ws });
	} catch (e) { console.log("(git 基线提交失败，可能无身份配置:", String(e.message).slice(0, 80), ")"); }
	fs.writeFileSync(`${ws}/p0-tracked.txt`, "line1\nCHANGED\nline3\nline4\n");
	fs.writeFileSync(`${ws}/p0-new.md`, "# 新文件\n由 P0 E2E 创建\n");

	await ev(client, `showDock("review")`);
	await sleep(1500);
	console.log("dock打开:", await ev(client, "!document.getElementById('dock').hidden"));
	console.log("review pane可见:", await ev(client, "!document.getElementById('dock-pane-review').hidden"));
	console.log("分支行:", await ev(client, "document.getElementById('review-branch').textContent"));
	console.log("变更项数:", await ev(client, "document.querySelectorAll('.review-file').length"));
	console.log("角标计数:", await ev(client, "document.getElementById('review-cnt').textContent"));
	await shot(client, "1-review");

	// ---- 2. 点击新文件展开 diff（验证 untracked 全 + 号 diff）----
	console.log("== 2. 新文件 diff ==");
	await ev(client, `[...document.querySelectorAll('.review-file')].find(x => x.textContent.includes('p0-new.md')).click()`);
	await sleep(1200);
	const newDiff = await ev(client, `[...document.querySelectorAll('.git-pre')].find(p => !p.hidden)?.textContent.slice(0, 300)`);
	console.log("新文件diff预览:", JSON.stringify(newDiff));

	// ---- 3. 点击已跟踪文件展开 diff（验证 -/+ 行）----
	console.log("== 3. 已跟踪文件 diff ==");
	await ev(client, `[...document.querySelectorAll('.review-file')].find(x => x.textContent.includes('p0-tracked.txt')).click()`);
	await sleep(1500);
	const diffs = await ev(client, `[...document.querySelectorAll('.git-pre')].filter(p => !p.hidden).map(p => p.textContent.slice(0, 260))`);
	console.log("展开的diff数:", diffs.length);
	for (const d of diffs) console.log("---", JSON.stringify(d.slice(0, 200)));
	await shot(client, "3-diffs");

	// ---- 4. 切到预览标签再切回，验证标签互斥 ----
	console.log("== 4. 标签切换 ==");
	await ev(client, `showDock("preview")`);
	await sleep(400);
	console.log("preview可见/review隐藏:", await ev(client, "!document.getElementById('dock-pane-preview').hidden && document.getElementById('dock-pane-review').hidden"));
	await ev(client, `showDock("review")`);
	await sleep(1200);
	console.log("切回review仍可见:", await ev(client, "!document.getElementById('dock-pane-review').hidden"));
	await ev(client, `closeDock()`);
	await sleep(300);
	console.log("关闭后隐藏:", await ev(client, "document.getElementById('dock').hidden"));

	// ---- 5. 快捷键 Ctrl+Shift+G 重新打开审核 ----
	console.log("== 5. 快捷键 ==");
	await client.Input.dispatchKeyEvent({ type: "keyDown", modifiers: 3, key: "G", code: "KeyG", windowsVirtualKeyCode: 71 });
	await client.Input.dispatchKeyEvent({ type: "keyUp", modifiers: 3, key: "G", code: "KeyG", windowsVirtualKeyCode: 71 });
	await sleep(1500);
	console.log("快捷键打开审核:", await ev(client, "!document.getElementById('dock').hidden && !document.getElementById('dock-pane-review').hidden"));

	// ---- 6. 还原改动（tracked 还原 + untracked 回收站）----
	console.log("== 6. 还原 ==");
	await ev(client, `[...document.querySelectorAll('.rv-discard')][0].click()`);
	await sleep(600);
	// miniConfirm 确认
	console.log("确认弹窗出现:", await ev(client, "!document.getElementById('mini-mask').hidden"));
	await ev(client, `document.getElementById('mini-ok').click()`);
	await sleep(1500);
	console.log("还原后变更项数:", await ev(client, "document.querySelectorAll('.review-file').length"));
	await shot(client, "6-after-discard");
	console.log("== 完成 ==");
	process.exit(0);
};

main().catch((e) => { console.error("E2E 失败:", e.message); process.exit(1); });
