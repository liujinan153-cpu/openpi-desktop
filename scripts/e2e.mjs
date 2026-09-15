/**
 * M1 E2E 驱动脚本：通过 CDP 操控真实桌面应用
 * 用法: node scripts/e2e.mjs
 */
import CDP from "chrome-remote-interface";
import fs from "node:fs";

const PORT = 9333;
const app = "E:/pi2/openpi-desktop";

const connect = async () => {
	const tabs = await CDP.List({ port: PORT });
	const page = tabs.find((t) => t.type === "page");
	if (!page) throw new Error("no page target");
	return CDP({ target: page.webSocketDebuggerUrl });
};

const ev = (client, expr) =>
	client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => {
		if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description ?? "").slice(0, 300));
		return r.result.value;
	});

const waitSettled = async (client, timeoutMs = 150000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 2000));
		const streaming = await ev(client, "state.streaming");
		if (!streaming) {
			const n = await ev(client, "document.querySelectorAll('.msg').length");
			if (n > 0) return n;
		}
	}
	throw new Error("等待超时");
};

const main = async () => {
	const client = await connect();
	await client.Runtime.enable();

	// ---- 0. 冒烟 ----
	console.log("== 冒烟 ==");
	console.log("库:", await ev(client, "[typeof marked, typeof DOMPurify, typeof hljs].join(',')"));
	console.log("侧栏会话数:", await ev(client, "document.querySelectorAll('.s-item').length"));

	// ---- 1. 新会话 + 发送触发 edit 的任务 ----
	console.log("== 新会话 ==");
	await ev(client, "document.getElementById('btn-new').click()");
	await new Promise((r) => setTimeout(r, 3000));

	const prompt = [
		"请完成两件事:",
		"1. 在当前目录创建文件 hello.md，内容如下（原样写入）:",
		"# Hello OpenPi",
		"",
		"这是一个 **测试文件**，用于验证 `openpi-desktop` 的 Markdown 渲染。",
		"",
		"- 项目: openpi-desktop",
		"- 引擎: pi coding agent",
		"2. 用 read 工具读回该文件确认内容。完成后简短回复。",
	].join("\n");
	await ev(client, `document.getElementById('input').value = ${JSON.stringify(prompt)}`);
	await ev(client, `document.getElementById('btn-send').click()`);

	const nMsgs = await waitSettled(client);
	console.log("== 对话结束 ==");
	console.log(
		JSON.stringify(
			{
				消息数: nMsgs,
				Diff卡: await ev(client, "document.querySelectorAll('.diff').length"),
				Diff行数: await ev(client, "document.querySelectorAll('.diff .dl').length"),
				Markdown气泡: await ev(client, "document.querySelectorAll('.body.md').length"),
				代码块: await ev(client, "document.querySelectorAll('.md pre code').length"),
				工具卡: await ev(client, "document.querySelectorAll('.tool').length"),
				侧栏会话数: await ev(client, "document.querySelectorAll('.s-item').length"),
				状态: await ev(client, "document.getElementById('status-left').textContent"),
			},
			null,
			1,
		),
	);
	console.log("回复摘要:", (await ev(client, "document.querySelector('.msg.assistant .body')?.textContent"))?.slice(0, 150));

	// ---- 2. 渲染器截图 ----
	const { data } = await client.Page.captureScreenshot({ format: "png" });
	fs.writeFileSync(`${app}/m1-proof.png`, Buffer.from(data, "base64"));
	console.log("截图: m1-proof.png");

	// ---- 3. 侧栏点击恢复第一个历史会话 ----
	console.log("== 恢复历史会话 ==");
	await ev(client, "document.querySelectorAll('.s-item')[0].click()");
	await new Promise((r) => setTimeout(r, 6000));
	console.log(
		JSON.stringify(
			{
				恢复后消息数: await ev(client, "document.querySelectorAll('.msg').length"),
				状态: await ev(client, "document.getElementById('status-left').textContent"),
				活动项: await ev(client, "document.querySelectorAll('.s-item.active').length"),
			},
			null,
			1,
		),
	);

	client.close();
	process.exit(0);
};

main().catch((x) => {
	console.error("E2E 失败:", x.message);
	process.exit(1);
});
