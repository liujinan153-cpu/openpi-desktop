/** E2E-5: M2 验证 —— 审批拦截 / 会话树 / 压缩 / 导出 / 改名 / 上下文条 */
import CDP from "chrome-remote-interface";
import fs from "node:fs";

const client = await CDP({ target: (await CDP.List({ port: 9333 })).find((t) => t.type === "page").webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = (expr) =>
	client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => {
		if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description ?? "").slice(0, 300));
		return r.result.value;
	});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitSettled = async (timeout = 150000) => {
	const dl = Date.now() + timeout;
	while (Date.now() < dl) {
		await sleep(1500);
		if (!(await ev("state.streaming")) && (await ev("document.querySelectorAll('.msg').length")) > 0) return;
	}
	throw new Error("等待超时");
};

// 就绪等待
for (let i = 0; i < 25; i++) {
	await sleep(1500);
	if (await ev("state.session !== null")) break;
}
console.log("== M2 E2E 开始 ==");
console.log("M2按钮:", await ev(`['btn-compact','btn-tree','btn-export','btn-rename'].every(id=>!!document.getElementById(id))`));

// ---- 1. 先来一轮短对话（制造树节点）----
await ev(`document.getElementById('input').value = ${JSON.stringify("只回复两个字：收到")}`);
await ev("document.getElementById('btn-send').click()");
await waitSettled();
console.log("短对话完成, 消息数:", await ev("document.querySelectorAll('.msg').length"));

// ---- 2. 危险命令审批：触发 rm -rf → confirm 弹窗 → 拒绝 ----
console.log("== 审批测试 ==");
await ev(`document.getElementById('input').value = ${JSON.stringify("用 bash 工具执行这个命令: rm -rf hello.md 。执行完报告结果。")}`);
await ev("document.getElementById('btn-send').click()");
// 轮询等待审批弹窗
let approved = false;
const dl = Date.now() + 120000;
while (Date.now() < dl) {
	await sleep(600);
	if (await ev(`!!document.querySelector('.modal-mask .ui-no')`)) {
		console.log("审批弹窗出现, 弹窗文本:", (await ev(`document.querySelector('.ui-msg')?.textContent`))?.slice(0, 80));
		await ev(`document.querySelector('.modal-mask .ui-no').click()`); // 拒绝
		approved = true;
		break;
	}
	if (!(await ev("state.streaming")) && (await ev("document.querySelectorAll('.msg').length")) > 2) break;
}
console.log("审批弹窗被触发:", approved);
await waitSettled();
const lastText = await ev(`[...document.querySelectorAll('.msg.assistant .body')].pop()?.textContent ?? ''`);
console.log("拒绝后 agent 反应含'拒绝':", /拒绝/.test(lastText), "| 摘要:", String(lastText).slice(0, 100));

// ---- 3. 会话树 ----
console.log("== 会话树 ==");
await ev("document.getElementById('btn-tree').click()");
await sleep(1200);
const nodeCount = await ev("document.querySelectorAll('.tree-node').length");
console.log("树节点数:", nodeCount);
const shot = { data: (await client.Page.captureScreenshot({ format: "png" })).data };
fs.writeFileSync("E:/pi2/openpi-desktop/m2-tree-proof.png", Buffer.from(shot.data, "base64"));
await ev(`document.querySelector('.tree-close').click()`);

// ---- 4. 导出 HTML + 改名 ----
console.log("== 导出/改名 ==");
await ev("document.getElementById('btn-export').click()");
await sleep(5000);
const exportLine = await ev(`[...document.querySelectorAll('.sys')].pop()?.textContent ?? ''`);
console.log("导出结果:", exportLine.slice(0, 130));
await ev("document.getElementById('btn-rename').click()");
await sleep(500);
await ev(`document.querySelector('.ui-in').value = 'M2-E2E-测试会话'`);
await ev(`document.querySelector('.modal-mask .ui-ok').click()`);
await sleep(2500);
console.log("改名结果:", (await ev(`[...document.querySelectorAll('.sys')].pop()?.textContent ?? ''`)).slice(0, 80));

// ---- 5. 手动压缩 ----
console.log("== 压缩 ==");
await ev("document.getElementById('btn-compact').click()");
await sleep(25000);
const compactLine = await ev(`[...document.querySelectorAll('.sys')].filter(x=>x.textContent.includes('压缩')).pop()?.textContent ?? ''`);
console.log("压缩结果:", compactLine.slice(0, 120));
console.log("上下文条宽度:", await ev(`document.getElementById('ctx-bar').style.width`), await ev(`document.getElementById('ctx-bar').style.background`));

console.log("== M2 E2E 完成 ==");
client.close();
process.exit(0);
