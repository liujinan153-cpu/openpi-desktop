/** E2E-4: 打包产物（portable exe）完整验证：真实对话 → 流式 → Markdown → 用量 */
import CDP from "chrome-remote-interface";
import fs from "node:fs";

const client = await CDP({ target: (await CDP.List({ port: 9334 })).find((t) => t.type === "page").webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = (expr) =>
	client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => {
		if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description ?? "").slice(0, 300));
		return r.result.value;
	});

// 等待会话就绪
let ready = false;
for (let i = 0; i < 30; i++) {
	await new Promise((r) => setTimeout(r, 1500));
	ready = await ev("state.session !== null && state.models.length > 0");
	if (ready) break;
}
if (!ready) throw new Error("打包版会话未就绪");
console.log("模型数:", await ev("state.models.length"));
console.log("状态:", await ev("document.getElementById('status-left').textContent"));
console.log("侧栏会话:", await ev("document.querySelectorAll('.s-item').length"));

// 发一条带 Markdown 的任务
const prompt = "不使用工具，直接回答：用一行 Python 代码计算 1 到 100 的平方和，放在 python 代码块里；再用一个无序列表列出 openpi-desktop 的两个卖点。";
await ev(`document.getElementById('input').value = ${JSON.stringify(prompt)}`);
await ev("document.getElementById('btn-send').click()");

const deadline = Date.now() + 150000;
while (Date.now() < deadline) {
	await new Promise((r) => setTimeout(r, 2000));
	if (!(await ev("state.streaming")) && (await ev("document.querySelectorAll('.msg').length")) > 0) break;
}

console.log(
	JSON.stringify(
		{
			Markdown气泡: await ev("document.querySelectorAll('.body.md').length"),
			代码块: await ev("document.querySelectorAll('.md pre code').length"),
			高亮span: await ev("document.querySelectorAll('.md pre code span').length"),
			列表项: await ev("document.querySelectorAll('.md ul li').length"),
			状态: await ev("document.getElementById('status-left').textContent"),
			用量: await ev("document.getElementById('usage').textContent"),
		},
		null,
		1,
	),
);
const { data } = await client.Page.captureScreenshot({ format: "png" });
fs.writeFileSync("E:/pi2/openpi-desktop/dist-proof.png", Buffer.from(data, "base64"));
console.log("截图: dist-proof.png");
client.close();
process.exit(0);
