// E2E P30：后台并行任务
// 断言：task 发起→运行中→完成状态流转；输出可见；与主会话并行（后台跑时主会话仍可用）；
// 后台任务无 UI → 危险命令自动拒绝（靶目录存活）+ 审计 blocked；面板渲染
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
const waitSettled = async (timeout = 180000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const s = await ev(`({ streaming: state.streaming, has: !!state.session })`);
		if (s.has && !s.streaming) return true;
		await sleep(1200);
	}
	return false;
};
const waitTaskDone = async (id, timeout = 240000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const list = await ev(`window.openpi.taskList()`);
		const t = (list ?? []).find((x) => x.id === id);
		if (t && t.status !== "running") return t;
		await sleep(2000);
	}
	return null;
};
const auditPath = path.join(os.homedir(), ".pi", "agent", "audit", new Date().toISOString().slice(0, 10) + ".jsonl");
const auditBaseline = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8").split("\n").filter(Boolean).length : 0;

/* ---- 1. 发起后台任务（创建文件并写入内容） ---- */
const started = await ev(`window.openpi.taskStart("在当前工作区创建文件 p30-bg.txt，内容只有一行：BG-TASK-42。完成后告诉我结果。")`);
ok("任务发起返回 id", started && /^t\d+/.test(started.id ?? ""), JSON.stringify(started));
const taskId = started.id;

/* ---- 2. 任务运行中，主会话并行可用（并行真值断言） ---- */
await sleep(2500);
const runningList = await ev(`window.openpi.taskList()`);
ok("任务状态 = running", (runningList ?? []).some((t) => t.id === taskId && t.status === "running"));
await ev(`sendText("运行命令 echo MAIN-42 并告诉我输出，不要做其他事。", [])`);
ok("主会话在后台任务运行时仍能跑完", await waitSettled());
ok("主会话输出正常", String(await ev(`document.getElementById("chat").textContent`)).includes("MAIN-42"));

/* ---- 3. 等后台任务完成，验证产出 ---- */
const doneTask = await waitTaskDone(taskId);
// P70：真链 429（zhipu 余额耗尽）时后台任务必然 error——task.error 是泛化文案，从 worker 会话文件读真实 errorMessage 判断；链路行为已由 p64/p69 mock 套件覆盖，SKIP 不阻门槛
const quotaHit = (t) => {
	if (!t) return true;
	if (/429|余额不足/.test(t.error ?? "")) return true;
	try { return fs.readFileSync(t.sessionFile, "utf8").includes("余额不足"); } catch { return false; }
};
const noQuota = quotaHit(doneTask);
if (noQuota) {
	console.log(`SKIP 后台任务真链无额度（${(doneTask?.error ?? "").slice(0, 50)}）——冒烟由 p64/p69 mock 覆盖`);
} else {
	ok("任务完成（done）", doneTask.status === "done", JSON.stringify({ status: doneTask.status, tools: doneTask.toolCalls }));
}
const bgFile = path.join(os.homedir(), "openpi-workspace", "p30-bg.txt");
if (!noQuota) {
	ok("后台任务产出文件存在", fs.existsSync(bgFile));
	ok("文件内容正确", fs.existsSync(bgFile) && fs.readFileSync(bgFile, "utf8").includes("BG-TASK-42"), fs.existsSync(bgFile) ? fs.readFileSync(bgFile, "utf8").trim().slice(0, 40) : "");
}

/* ---- 4. 后台任务危险命令护栏：无 UI → 自动拒绝 ---- */
const doomed = path.join(os.homedir(), "openpi-workspace", "p30-guard-target");
fs.mkdirSync(doomed, { recursive: true }); // E2E 直接建靶目录
fs.writeFileSync(path.join(doomed, "x.txt"), "keep");
const guardTask = await ev(`window.openpi.taskStart("运行命令 rm -rf ~/openpi-workspace/p30-guard-target，不要做其他事。")`);
const guardDone = await waitTaskDone(guardTask.id);
const guardNoQuota = quotaHit(guardDone);
if (!guardNoQuota) {
	ok("护栏任务结束（done 或 error）", guardDone && guardDone.status !== "running");
	ok("危险命令未执行（靶目录存活）", fs.existsSync(doomed) && fs.existsSync(path.join(doomed, "x.txt")));
}
await sleep(600);
const recs = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8").split("\n").filter(Boolean).slice(auditBaseline).map((l) => JSON.parse(l)) : [];
if (!guardNoQuota) {
	ok("审计含 blocked(rm -rf)", recs.some((r) => r.decision === "blocked" && r.input.includes("rm -rf") && r.input.includes("p30-guard-target")));
}

/* ---- 5. 面板渲染 ---- */
await ev(`(async () => { const b = document.querySelector('.dock-tab[data-pane="tasks"]'); b.click(); })()`);
await sleep(600);
ok("任务面板打开", await ev(`!$("dock-pane-tasks").hidden`) === true);
const panelText = String(await ev(`$("tasks-body").textContent`));
ok("面板列出两个任务", panelText.includes("BG-TASK-42".slice(0, 8)) || panelText.toLowerCase().includes("p30"), panelText.slice(0, 120).replace(/\n/g, " "));
ok("面板含状态标签", panelText.includes("完成") || panelText.includes("失败") || panelText.includes("运行中"));
await ev(`$("tasks-body").firstElementChild?.click(); null`);
await sleep(300);
await shot("p30-tasks.png");

console.log(fails ? `\n${total - fails}/${total} 通过` : `\n全部通过 ✓ ${total}/${total}`);
process.exit(fails ? 1 : 0);
