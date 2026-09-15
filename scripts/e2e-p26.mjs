// E2E P26：P0 三件套收尾验证
//  1. 审核 dock（P0-1，已有功能回归）：git 变更文件出现 + diff 展开 + 还原/提交按钮
//  2. 系统通知（P0-2）：app:notify 通道可用
//  3. AGENTS.md 呈现（P0-3）：ctx:agentsFiles 返回工作区清单 + chip + dock 面板 + 生成按钮
// 前置：应用带 --remote-debugging-port=9333 启动
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

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
let fails = 0;
const ok = (name, cond, extra = "") => {
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

/* ---- 0. 确保项目模式（任务模式残留则切回默认工作区） ---- */
const wsDefault = path.join(os.homedir(), "openpi-workspace").replace(/\\/g, "/");
if (await ev(`state.session?.workspace == null`)) {
	await ev(`(async () => { resetChat(); await startSession("${wsDefault}"); })()`);
	await sleep(2500);
}

/* ---- 1. 审核 dock 回归（P0-1，已有功能） ---- */
const ws = await ev(`state.session?.workspace || ""`);
ok("有工作区", !!ws, ws);
fs.mkdirSync(ws, { recursive: true }); // 工作区目录可能首次使用
const git = (...a) => execFileSync("git", a, { cwd: ws, stdio: "pipe" });
if (!fs.existsSync(path.join(ws, ".git"))) {
	git("init", "-b", "main");
	git("-c", "user.name=P26", "-c", "user.email=p26@e2e.local", "add", "-A");
	git("-c", "user.name=P26", "-c", "user.email=p26@e2e.local", "commit", "--allow-empty", "-m", "init");
}
const probe = path.join(ws, `p26-probe-${Date.now()}.txt`);
fs.writeFileSync(probe, "P26 review probe\n");
const st = await ev(`window.openpi.gitStatus()`);
ok("gitStatus 含探针文件", typeof st === "string" && st.includes(path.basename(probe)));
await ev(`showDock("review"); null`);
await sleep(1000);
const rvBody = await ev(`$("review-body").textContent`);
ok("审核面板列出探针文件", rvBody.includes(path.basename(probe)));
ok("提交按钮存在", await ev(`!!$("review-commit-btn")`));
ok("还原按钮存在", (await ev(`document.querySelectorAll("#review-body .rv-discard").length`)) > 0);
const probeName = path.basename(probe);
const diff = await ev(`(async () => {
	showDock("review"); await new Promise(r=>setTimeout(r,900));
	const name = ${JSON.stringify(probeName)};
	const el = [...document.querySelectorAll("#review-body .review-file")].find((e) => e.textContent.includes(name));
	if (!el) return "no-row:" + [...document.querySelectorAll("#review-body .review-file")].map((e) => e.textContent.slice(0,40)).join("|");
	el.click();
	for (let t = 0; t < 20; t++) {
		await new Promise((r) => setTimeout(r, 100));
		const pre = el.nextElementSibling;
		if (pre && !pre.hidden && !pre.textContent.includes("加载")) return pre.textContent.slice(0, 200);
	}
	return "";
})()`);
ok("diff 展开含探针内容", diff.includes("P26 review probe"), JSON.stringify(diff.slice(0, 60)));

/* ---- 2. 系统通知（P0-2） ---- */
const notify = await ev(`window.openpi.notify("P26 通知测试", "E2E 探针")`);
ok("notify 通道可用", !!notify && (notify.ok === true || notify.reason === "unsupported"), JSON.stringify(notify));

/* ---- 3. AGENTS.md 呈现（P0-3） ---- */
const agentsMd = path.join(ws, "AGENTS.md");
let wrote = false;
if (!fs.existsSync(agentsMd)) {
	fs.writeFileSync(agentsMd, "# P26 E2E 临时 AGENTS.md\n\n测试指令文件，可删除。\n");
	wrote = true;
}
const files = await ev(`window.openpi.agentsFiles()`);
ok("agentsFiles 为数组", Array.isArray(files));
ok("清单含工作区 AGENTS.md", Array.isArray(files) && files.some((f) => path.resolve(f.path) === path.resolve(agentsMd)));
await ev(`refreshAgentsChip(); null`);
await sleep(300);
ok("chip 可见且计数 ≥1", await ev(`!$("chip-agents").hidden && /AGENTS×[1-9]/.test($("agents-label").textContent)`));
await ev(`showDock("agents"); null`);
await sleep(400);
const agBody = await ev(`$("agents-body").textContent`);
ok("指令面板列出该文件", agBody.includes(path.basename(agentsMd)));
ok("生成按钮存在", await ev(`!!$("agents-generate")`));
ok("打开按钮数与文件数一致", (await ev(`document.querySelectorAll("#agents-body .rv-open").length`)) === files.length);

await shot("p26-agents.png");

/* 清理探针（不动 AGENTS.md：属工作区正常文件，留着供面板展示） */
fs.rmSync(probe, { force: true });

console.log(fails ? `\n${12 - fails}/12 通过` : `\n全部通过 ✓ 12/12`);
process.exit(fails ? 1 : 0);
