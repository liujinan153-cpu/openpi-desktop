/** E2E-7: 打包版(0.3.0) M2 验证 —— 审批拦截 + 会话树 + 上下文条 */
import CDP from "chrome-remote-interface";
import fs from "node:fs";

const client = await CDP({ target: (await CDP.List({ port: 9334 })).find((t) => t.type === "page").webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = (expr) =>
	client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => {
		if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description ?? "").slice(0, 300));
		return r.result.value;
	});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < 30; i++) {
	await sleep(1500);
	if (await ev("state.session !== null")) break;
}
console.log("模型数:", await ev("state.models.length"));
console.log("M2按钮齐:", await ev(`['btn-compact','btn-tree','btn-export','btn-rename'].every(id=>!!document.getElementById(id))`));

// 审批链路
await ev(`document.getElementById('input').value = ${JSON.stringify("用 bash 工具执行: rm -rf hello.md ，执行完报告结果。")}`);
await ev("document.getElementById('btn-send').click()");
let hit = false;
const dl = Date.now() + 120000;
while (Date.now() < dl) {
	await sleep(600);
	if (await ev(`!!document.querySelector('.modal-mask .ui-no')`)) {
		hit = true;
		console.log("✓ 打包版审批弹窗出现:", (await ev(`document.querySelector('.ui-msg')?.textContent`))?.slice(0, 60));
		await ev(`document.querySelector('.modal-mask .ui-ok').click()`); // 这次点「允许」验证放行路径
		break;
	}
}
if (!hit) console.log("✗ 弹窗未出现");
const dl2 = Date.now() + 120000;
while (Date.now() < dl2) {
	await sleep(1500);
	if (!(await ev("state.streaming"))) break;
}
const last = await ev(`[...document.querySelectorAll('.msg.assistant .body')].pop()?.textContent ?? ''`);
console.log("放行路径:", /exit_code|已删除|hello/.test(String(last)) ? "✓ 命令放行并执行" : String(last).slice(0, 80));

// 会话树
await ev("document.getElementById('btn-tree').click()");
await sleep(1000);
console.log("树节点:", await ev("document.querySelectorAll('.tree-node').length"));
const { data } = await client.Page.captureScreenshot({ format: "png" });
fs.writeFileSync("E:/pi2/openpi-desktop/m2-dist-proof.png", Buffer.from(data, "base64"));
console.log("截图: m2-dist-proof.png");
client.close();
process.exit(0);
