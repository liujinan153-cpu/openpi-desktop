// E2E P34：块级采纳（stage 单块 → commit 只含采纳块）+ 跨会话消息搜索
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
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

/* miniConfirm 自动确认（identity 场景可用 dataset.noauto 关闭） */
await client.Runtime.evaluate({ expression: `(() => {
	const mask = document.getElementById("mini-mask");
	if (!mask || window.__miniHooked) return;
	window.__miniHooked = true;
	new MutationObserver(() => {
		if (mask.dataset.noauto) return;
		if (!mask.hidden && !mask.dataset.autoclicked) {
			mask.dataset.autoclicked = "1";
			setTimeout(() => document.getElementById("mini-ok")?.click(), 400);
		}
		if (mask.hidden && mask.dataset.autoclicked) delete mask.dataset.autoclicked;
	}).observe(mask, { attributes: true, attributeFilter: ["hidden"] });
})()`, returnByValue: true });

/* 会话前置（渲染层状态同步） */
await ev(`startSession(undefined).then(() => null)`);
await sleep(1200);

/* ---- 1. 块级采纳 → 智能 commit ---- */
const ws = path.join(os.homedir(), "openpi-workspace");
const f = path.join(ws, "p34-stage.txt");
const git = (...a) => execFileSync("git", a, { cwd: ws, stdio: "pipe" });
const base = Array.from({ length: 12 }, (_, i) => `row-${i + 1}`).join("\n") + "\n";
fs.writeFileSync(f, base);
git("add", "-A");
git("-c", "user.name=P34", "-c", "user.email=p34@e2e.local", "commit", "-m", "p34 baseline", "--allow-empty");
const modified = base.replace("row-2\n", "KEEP-A\n").replace("row-11\n", "DROP-B\n"); // 两个 hunk：A 想要，B 不想要
fs.writeFileSync(f, modified);

await ev(`showDock("review"); null`);
await sleep(800);
await ev(`(async () => {
	const rows = [...document.querySelectorAll(".review-file")];
	const i = rows.findIndex((r) => r.querySelector(".path")?.textContent?.includes("p34-stage.txt"));
	if (i >= 0) rows[i].click();
})()`);
await sleep(700);
ok("diff 渲染 2 个待处理块（含采纳按钮）", (await ev(`document.querySelectorAll(".hunk .hunk-stage").length`)) === 2);

// 采纳第 1 块（KEEP-A）：中间态断言用 sysline + git 真值（DOM 计数受 refreshReview 折叠重绘时序干扰，不值得硬等）
await ev(`document.querySelector('.hunk[data-h="0"] .hunk-stage')?.click(); null`);
let sysOk = false;
for (let i = 0; i < 10; i++) {
	await sleep(500);
	const sys = await ev(`[...document.querySelectorAll(".sysline")].map((e) => e.textContent).join(" || ")`);
	if (sys.includes("已采纳块")) { sysOk = true; break; }
}
ok("采纳成功 sysline 反馈", sysOk);
ok("index 已含 KEEP-A（git 真值）", (() => { try { const r = execFileSync("git", ["diff", "--cached", "--", "p34-stage.txt"], { cwd: ws }).toString(); return r.includes("KEEP-A") && !r.includes("DROP-B"); } catch { return false; } })());
ok("待处理仅剩 DROP-B（git 真值）", (() => { try { const r = execFileSync("git", ["diff", "--", "p34-stage.txt"], { cwd: ws }).toString(); return r.includes("DROP-B") && !r.includes("KEEP-A"); } catch { return false; } })());

// commit（miniConfirm 自动确认"只提交已采纳块"）
await ev(`(async () => { const m = document.getElementById("review-msg"); m.value = "p34 stage only KEEP-A"; document.getElementById("review-commit-btn").click(); })()`);
await sleep(1500);
const lastMsg = git("log", "-1", "--pretty=%B").toString().trim();
ok("commit 只含采纳块", lastMsg === "p34 stage only KEEP-A", lastMsg);
const committed = execFileSync("git", ["show", "HEAD", "--", "p34-stage.txt"], { cwd: ws }).toString();
ok("提交内容含 KEEP-A", committed.includes("KEEP-A"));
ok("提交不含 DROP-B", !committed.includes("DROP-B"));
const worktree = fs.readFileSync(f, "utf8");
ok("未采纳块仍在工作区", worktree.includes("DROP-B"));

/* ---- 2. 跨会话消息搜索 ---- */
const marker = `P34-NEEDLE-${Date.now()}`;
const hitFile = path.join(ws, "p34-note.txt");
fs.writeFileSync(hitFile, marker);
await ev(`sendText("请把这句话原样告诉我（不要执行任何命令）：${marker}", [])`);
const t0 = Date.now();
let settled = false;
while (Date.now() - t0 < 90000) {
	const s = await ev(`({ streaming: state.streaming, has: !!state.session })`);
	if (s.has && !s.streaming) { settled = true; break; }
	await sleep(1500);
}
ok("含标记词的会话已跑完", settled);

await ev(`sessionFilter.focus(); null`);
await ev(`(async () => { const el = document.getElementById("session-filter"); el.value = "${marker}"; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
let hits = -1;
for (let i = 0; i < 12; i++) {
	await sleep(600);
	hits = await ev(`document.querySelectorAll(".deep-hit").length`);
	if (hits > 0) break;
}
ok("深搜命中当前会话", hits > 0, `hits=${hits}`);
const hitText = await ev(`document.querySelector(".deep-hit .pv")?.textContent ?? ""`);
ok("匹配行含标记词", hitText.includes(marker));
await shot("p34-search.png");

/* ---- 3. git 身份缺失：中文弹窗补配 + 自动重试（v0.29.1）---- */
// useConfigOnly 强制要求显式身份 → 稳定复现 identity 错误
try { git("config", "--unset", "user.useConfigOnly"); } catch { /* 没设过 */ }
git("config", "user.useConfigOnly", "true");
try { git("config", "--unset", "user.name"); } catch { /* 没设过 */ }
try { git("config", "--unset", "user.email"); } catch { /* 没设过 */ }
await ev(`document.getElementById("mini-mask").dataset.noauto = "1"; null`); // 关自动确认：identity 表单需手动填
await ev(`(async () => { const m = document.getElementById("review-msg"); m.value = "p34 identity rescue"; document.getElementById("review-commit-btn").click(); })()`);
// 等 identity 表单弹出（非自动确认模式下手动填）
let formUp = false;
for (let i = 0; i < 12; i++) {
	await sleep(500);
	const t = await ev(`({ hidden: document.getElementById("mini-mask").hidden, title: document.getElementById("mini-title").textContent, two: !document.getElementById("mini-input2").hidden })`);
	if (!t.hidden && t.two) { formUp = true; break; }
}
ok("identity 表单弹出（双输入）", formUp);
await ev(`(async () => { document.getElementById("mini-input").value = "E2E 机器人"; document.getElementById("mini-input2").value = "e2e@test.local"; document.getElementById("mini-ok").click(); })()`);
let rescued = false;
for (let i = 0; i < 14; i++) {
	await sleep(600);
	const sys = await ev(`[...document.querySelectorAll(".sysline")].map((e) => e.textContent).join(" || ")`);
	if (sys.includes("已提交: p34 identity rescue")) { rescued = true; break; }
}
ok("补配后自动重试提交成功", rescued);
ok("身份已写入本仓库", (() => { try { return git("config", "user.name").toString().trim() === "E2E 机器人"; } catch { return false; } })());
const author = git("log", "-1", "--pretty=%an").toString().trim();
ok("提交作者为补配身份", author === "E2E 机器人", author);
try { git("config", "--unset", "user.useConfigOnly"); } catch { /* 清理 */ }
await shot("p34-identity.png");

console.log(fails ? `\n${total - fails}/${total} 通过` : `\n全部通过 ✓ ${total}/${total}`);
process.exit(fails ? 1 : 0);
