/** P1.6 E2E：侧栏 项目/任务 双 tab + 去掉重复新会话入口 */
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
	fs.writeFileSync(`${APP}/p16-${name}.png`, Buffer.from(r.data, "base64"));
	console.log(`📸 p16-${name}.png`);
};

const main = async () => {
	const client = await connect();
	await client.Runtime.enable();
	await client.Page.enable();

	console.log("== 1. 去重 ==");
	console.log("顶栏 btn-new 已移除:", await ev(client, "!document.getElementById('btn-new')"));
	console.log("侧栏新对话存在:", await ev(client, "!!document.getElementById('btn-new-side')"));

	console.log("== 2. tab 标签 ==");
	console.log("tab 文案:", await ev(client, "[...document.querySelectorAll('.side-tabs button')].map(b=>b.textContent)"));

	console.log("== 3. 项目 tab（按本地工作区分组） ==");
	await ev(client, `setSideTab("projects")`);
	await sleep(400);
	console.log("项目组数:", await ev(client, "document.querySelectorAll('.proj-head').length"));
	console.log("无「最近」平铺区:", await ev(client, "![...document.querySelectorAll('.group-title')].some(g=>g.textContent==='最近')"));

	console.log("== 4. 任务 tab（普通聊天平铺） ==");
	await ev(client, `setSideTab("flat")`);
	await sleep(400);
	console.log("无项目树头:", await ev(client, "document.querySelectorAll('.proj-head').length === 0"));
	console.log("组标题:", await ev(client, "[...document.querySelectorAll('.group-title')].map(g=>g.textContent)"));
	console.log("任务条目数>0:", await ev(client, "document.querySelectorAll('.s-item').length > 0"));
	console.log("任务视图无📁徽标:", await ev(client, `[...document.querySelectorAll('.s-item .cwd')].length === 0`));

	console.log("== 5. 新对话 + Ctrl+N ==");
	await ev(client, `document.getElementById('btn-new-side').click()`);
	await sleep(1200);
	console.log("侧栏按钮开新会话:", await ev(client, `!!state.session`));
	console.log("== 完成 ==");
	process.exit(0);
};

main().catch((e) => { console.error("E2E 失败:", e.message); process.exit(1); });
