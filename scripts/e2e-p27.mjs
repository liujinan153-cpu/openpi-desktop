// E2E P27：P1 第一批（checkpoint 回滚 / Git 分支保护 / @ 文件补全）
// 前置：应用带 --remote-debugging-port=9333 启动，工作区为 ~/openpi-workspace（git 仓库）
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
let total = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};
const waitSettled = async (timeout = 180000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const s = await ev(`({ streaming: state.streaming, has: !!state.session })`);
		if (s.has && !s.streaming) return true;
		await sleep(1200);
	}
	return false;
};

/* ---- 0. 项目模式 + 干净 main 基线 ---- */
const ws = path.join(os.homedir(), "openpi-workspace");
fs.mkdirSync(ws, { recursive: true });
const git = (...a) => execFileSync("git", a, { cwd: ws, stdio: "pipe" });
if (!fs.existsSync(path.join(ws, ".git"))) {
	git("init", "-b", "main");
	git("add", "-A");
	git("commit", "--allow-empty", "-m", "init");
}
git("config", "user.name", "P27");
git("config", "user.email", "p27@e2e.local");
fs.rmSync(path.join(ws, "p27-ck.txt"), { force: true });
fs.writeFileSync(path.join(ws, "p27-pre.txt"), "PRE-V0\n"); // 预置文件：验证「被改后回滚」
git("-c", "user.name=P27", "-c", "user.email=p27@e2e.local", "add", "-A");
git("-c", "user.name=P27", "-c", "user.email=p27@e2e.local", "commit", "-m", "p27 baseline", "--allow-empty");
git("checkout", "main", "-q"); // 确保从 main 开始
// 清理上次失败残留：工作区产物 + 遗留保护分支（分支上的内容不重要，E2E 可丢弃）
fs.rmSync(path.join(ws, "p27-feat.txt"), { force: true });
try {
	const brs = git("branch", "--list", "openpi/*").toString().split("\n").map((s) => s.replace("*", "").trim()).filter(Boolean);
	for (const b of brs) git("branch", "-D", b);
} catch { /* 无残留 */ }
if ((git("rev-parse", "--abbrev-ref", "HEAD").toString().trim() !== "main")) {
	try { git("branch", ["-D", "main"].flat()); } catch { /* noop */ }
}
if (await ev(`state.session?.workspace == null`)) {
	await ev(`(async () => { resetChat(); await startSession(${JSON.stringify(ws.replace(/\\/g, "/"))}); })()`);
	await sleep(2500);
}
await waitSettled(60000);

/* ---- 1. checkpoint：agent 两轮写文件 → 快照回滚 ---- */
const ckFile = path.join(ws, "p27-ck.txt");
await ev(`sendText("在工作区创建文件 p27-ck.txt，内容恰好为一行：CHECKPOINT-V1。不要做其他事。", [])`);
ok("第一轮 settle", await waitSettled());
ok("V1 已写入", fs.readFileSync(ckFile, "utf8").trim() === "CHECKPOINT-V1");
const ck1 = await ev(`window.openpi.checkpointList()`);
ok("快照清单含 p27-ck.txt", Array.isArray(ck1) && ck1.some((c) => c.file === "p27-ck.txt"), JSON.stringify(ck1));

await ev(`sendText("把工作区 p27-ck.txt 的内容改成一行：CHECKPOINT-V2。不要做其他事。", [])`);
ok("第二轮 settle", await waitSettled());
ok("V2 已写入", fs.readFileSync(ckFile, "utf8").trim() === "CHECKPOINT-V2");

await ev(`sendText("把工作区 p27-pre.txt 的内容改成一行：PRE-V9。不要做其他事。", [])`);
ok("第三轮 settle", await waitSettled());
ok("V9 已写入", fs.readFileSync(path.join(ws, "p27-pre.txt"), "utf8").trim() === "PRE-V9");

/* UI：审核面板两个文件行都有 ⏪ 按钮（在仍有未提交改动时断言） */
await ev(`showDock("review"); null`);
await sleep(1000);
ok("审核面板有 ⏪ 回滚按钮", (await ev(`document.querySelectorAll("#review-body .ck-restore").length`)) === 2);

/* AI 创建的文件：回滚 = 删除 */
const rrNew = await ev(`window.openpi.checkpointRestore("p27-ck.txt")`);
ok("新建文件回滚调用成功", rrNew && rrNew.ok === true && rrNew.snap == null, JSON.stringify(rrNew));
ok("新建文件回滚后已删除", !fs.existsSync(ckFile));

/* 预置文件被改：回滚 = 恢复原内容 */
const rr = await ev(`window.openpi.checkpointRestore("p27-pre.txt")`);
ok("预置文件回滚调用成功", rr && rr.ok === true && rr.snap != null);
ok("回滚后内容回到 V0", fs.readFileSync(path.join(ws, "p27-pre.txt"), "utf8").trim() === "PRE-V0", fs.readFileSync(path.join(ws, "p27-pre.txt"), "utf8").trim());

/* ---- 2. Git 分支保护：整理工作区 → 切保护分支 → 提交 → 合并回 main ---- */
git("add", "-A");
git("-c", "user.name=P27", "-c", "user.email=p27@e2e.local", "commit", "-m", "p27 checkpoint test artifacts", "--allow-empty"); // 模拟用户整理后切分支
const before = await ev(`window.openpi.gitStatus()`);
const onMain = /##\s+main(\s|$)/.test(before || "");
if (onMain) {
	const pr = await ev(`window.openpi.gitProtect()`);
	ok("保护分支已创建并切换", pr.ok === true && pr.branch.startsWith("openpi/"), pr.branch ?? "");
} else {
	ok("保护分支已创建并切换", true, "已在非 main 分支，跳过创建");
}
await sleep(400);
await ev(`showDock("review"); null`);
await sleep(800);
const branchNow = await ev(`$("review-branch").textContent`);
ok("面板显示 openpi/* 分支", (branchNow || "").startsWith("openpi/"), branchNow);
ok("合并按钮可见", await ev(`!$("review-mergeback").hidden`));
fs.writeFileSync(path.join(ws, "p27-feat.txt"), `feature on protected branch ${Date.now()}
`); // 带时间戳：残留同名文件也不至于 nothing to commit
const cm = await ev(`window.openpi.gitCommit("p27 feature")`);
ok("保护分支上提交成功", cm && cm.ok !== false, JSON.stringify(cm).slice(0, 80));
const mb = await ev(`window.openpi.gitMergeBack()`);
ok("合并回 main 成功", mb && mb.ok === true, JSON.stringify(mb));
ok("main 上有特性文件", fs.existsSync(path.join(ws, "p27-feat.txt")));
const after = await ev(`window.openpi.gitStatus()`);
ok("切回 main 分支", /##\s+main(\s|$)/.test(after || ""), (after || "").split("\n")[0]);

/* ---- 3. @ 文件引用补全 ---- */
await ev(`(async () => { const i = document.getElementById("input"); i.value = "@p27"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
await sleep(700);
ok("@ 菜单可见", await ev(`!$("at-menu").hidden`));
ok("@ 菜单匹配到 p27 文件", (await ev(`[...atItems].some(f => f.includes("p27-ck.txt") || f.includes("p27-feat.txt"))`)));
await ev(`pickAt(0)`);
ok("选中后插入路径", (await ev(`document.getElementById("input").value`)).includes("p27-"));
await ev(`document.getElementById("input").value = "";`);

await ev(`showDock("review"); null`);
await sleep(400);
await shot("p27-p1.png");

/* 清理：回 main 后的测试产物保留（属工作区正常文件），分支保留 */
console.log(fails ? `
${total - fails}/${total} 通过` : `
全部通过 ✓ ${total}/${total}`);
process.exit(fails ? 1 : 0);
