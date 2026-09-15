// E2E P31：收尾打磨回归
// 断言：后台任务会话落独立目录（sessions-tasks）不污染主会话列表；任务功能不回归；审计卡片存在
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

/* ---- 1. 后台任务：功能回归 + 会话文件隔离 ---- */
const before = await ev(`window.openpi.listSessions().then((a) => a.length)`);
const id = await ev(`window.openpi.taskStart("在当前工作区创建文件 p31-iso.txt，内容只有一行：ISO-OK。完成后告诉我结果。").then((x) => x.id)`);
ok("任务发起", /^t\d+/.test(id ?? ""));
let done = null;
for (let i = 0; i < 60; i++) {
	await sleep(2000);
	const t = await ev(`window.openpi.taskList().then((a) => a.find((x) => x.id === ${JSON.stringify(id)}))`);
	if (t && t.status !== "running") { done = t; break; }
}
ok("任务完成", done?.status === "done", JSON.stringify({ s: done?.status, tc: done?.toolCalls, e: done?.error }));
ok("产出文件正确", fs.existsSync(path.join(os.homedir(), "openpi-workspace", "p31-iso.txt")) && fs.readFileSync(path.join(os.homedir(), "openpi-workspace", "p31-iso.txt"), "utf8").includes("ISO-OK"));
ok("会话文件落独立目录 sessions-tasks", typeof done?.sessionFile === "string" && done.sessionFile.includes(path.join(".pi", "agent", "sessions-tasks")), done?.sessionFile ?? "none");
const after = await ev(`window.openpi.listSessions().then((a) => a.map((s) => s.file ?? s.path ?? ""))`);
const polluted = (Array.isArray(after) ? after : []).some((f) => String(f).includes(String(done?.sessionFile ?? "\u0000")));
ok("主会话列表未被污染", !polluted, `列表数 ${before} → ${Array.isArray(after) ? after.length : "?"}`);

/* ---- 2. 审计卡片 ---- */
await ev(`(async () => { document.getElementById("btn-settings")?.click(); const m = document.getElementById("settings-mask"); if (m && m.classList.contains("hidden")) m.classList.remove("hidden"); renderSkillsPage?.(); })()`);
await sleep(600);
ok("审计卡片存在", await ev(`!!document.getElementById("audit-card") && !!document.getElementById("btn-audit-open")`));
await shot("p31-polish.png");

console.log(fails ? `\n${total - fails}/${total} 通过` : `\n全部通过 ✓ ${total}/${total}`);
process.exit(fails ? 1 : 0);
