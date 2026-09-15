/** P1.7 E2E：工作区选择器（搜索/最近/打开文件夹/不在项目中工作）+ 项目/任务不重合 */
import CDP from "chrome-remote-interface";
import fs from "node:fs";

const APP = "E:/pi2/openpi-desktop";
const connect = async () => {
	const tabs = await CDP.List({ port: 9333 });
	const page = tabs.find((t) => t.type === "page");
	return CDP({ target: page.webSocketDebuggerUrl });
};
const ev = (client, expr) =>
	client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => {
		if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description ?? "").slice(0, 400));
		return r.result.value;
	});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (client, name) => {
	const r = await client.Page.captureScreenshot({ format: "png", fromSurface: true });
	fs.writeFileSync(`${APP}/p17-${name}.png`, Buffer.from(r.data, "base64"));
	console.log(`📸 p17-${name}.png`);
};

const main = async () => {
	const client = await connect();
	await client.Runtime.enable();
	await client.Page.enable();

	// ---- 1. 选择器打开 / 搜索 / 关闭 ----
	console.log("== 1. 工作区选择器 ==");
	await ev(client, `document.getElementById('btn-workspace').click()`);
	await sleep(400);
	console.log("弹层打开:", await ev(client, `!document.getElementById('ws-picker').hidden`));
	console.log("列表项(已知项目):", await ev(client, `document.querySelectorAll('.ws-item').length`));
	console.log("当前项有✓:", await ev(client, `document.querySelectorAll('.ws-item .ws-check').length >= 1`));
	await ev(client, `(()=>{const s=document.getElementById('ws-search'); s.value='openpi-workspace'; s.dispatchEvent(new Event('input'))})()`);
	await sleep(300);
	console.log("搜索过滤后:", await ev(client, `[...document.querySelectorAll('.ws-item .ws-name')].map(x=>x.textContent)`));
	await shot(client, "1-picker");
	await ev(client, `document.body.click()`);
	await sleep(300);
	console.log("点外部关闭:", await ev(client, `document.getElementById('ws-picker').hidden`));

	// ---- 2. 不在项目中工作 → 任务模式 ----
	console.log("== 2. 任务模式 ==");
	const before = await ev(client, `document.querySelectorAll('.s-item').length`); // 任务tab当前条数（上次侧栏状态）
	await ev(client, `document.getElementById('btn-workspace').click()`);
	await sleep(300);
	await ev(client, `document.getElementById('ws-no-project').click()`);
	await sleep(2500);
	console.log("workspace=null:", await ev(client, `state.session?.workspace === null && state.session?.task === true`));
	console.log("chip 文案:", await ev(client, `document.getElementById('workspace-label').textContent`));
	console.log("meta 已打 task 标记:", await ev(client, `!!Object.values(state.meta).find(m=>m.task)`));
	// 发一条消息触发会话文件落盘
	await ev(client, `(()=>{const i=document.getElementById('input'); i.value='hello-task-check'; i.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('btn-send').click()})()`);
	await sleep(9000); // 等回合结束 → 文件落盘

	// ---- 3. 分类不重合 ----
	console.log("== 3. 分类不重合 ==");
	await ev(client, `setSideTab("flat")`); // 任务
	await sleep(500);
	const taskIds = await ev(client, `[...document.querySelectorAll(".s-item .pv")].map(x=>x.textContent)`);
	console.log("任务tab条数:", taskIds.length, "| 含 hello-task-check:", taskIds.some(t=>t.includes('hello-task-check')));
	await ev(client, `setSideTab("projects")`);
	await sleep(500);
	const projSet = await ev(client, `[...document.querySelectorAll(".s-item .pv")].map(x=>x.textContent)`);
	console.log("项目tab条数:", projSet.length, "| 不含任务会话:", !projSet.some(t=>t.includes('hello-task-check')));
	await shot(client, "2-projects-tab");

	// ---- 4. 从选择器切回工作区 ----
	console.log("== 4. 选择器切项目 ==");
	await ev(client, `document.getElementById('btn-workspace').click()`);
	await sleep(300);
	await ev(client, `document.querySelector('.ws-item').click()`);
	await sleep(2500);
	console.log("已切到项目工作区:", await ev(client, `!!state.session?.workspace && !state.session.task`));
	console.log("chip 文案:", await ev(client, `document.getElementById('workspace-label').textContent`));
	console.log("== 完成 ==");
	process.exit(0);
};

main().catch((e) => { console.error("E2E 失败:", e.message); process.exit(1); });
