/** E2E-8: M3 —— 多窗口并行会话 / 树导航 / 内核版本检查 */
import CDP from "chrome-remote-interface";
import fs from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkEv = (client) => (expr) =>
	client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => {
		if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description ?? "").slice(0, 250));
		return r.result.value;
	});
const connectPage = async (marker) => {
	const tabs = await CDP.List({ port: 9333 });
	const page = marker ? tabs.find((t) => t.type === "page" && t.id === marker) : tabs.find((t) => t.type === "page");
	return CDP({ target: page.webSocketDebuggerUrl });
};
const waitReady = async (ev) => {
	for (let i = 0; i < 30; i++) {
		await sleep(1500);
		if (await ev("state.session !== null && !state.streaming")) return true;
	}
	return false;
};

// ---- 窗口 A ----
const A = await connectPage();
await A.Runtime.enable();
const evA = mkEv(A);
await waitReady(evA);
console.log("A 就绪 · 模型数:", await evA("state.models.length"));

// A 开始长任务（保持 streaming）
await evA(`document.getElementById('input').value = ${JSON.stringify("写一篇 400 字的科幻微小说，不使用工具。")}`);
await evA("document.getElementById('btn-send').click()");
await sleep(2500);
const aStreaming = await evA("state.streaming");
console.log("A 流式中:", aStreaming);

// ---- A 触发新窗口 B ----
await evA("document.getElementById('btn-newwin').click()");
await sleep(6000);
const B = await connectPage();
await B.Runtime.enable();
const evB = mkEv(B);
await evB("window.__IS_B = true");
const bReady = await waitReady(evB);
console.log("B 就绪:", bReady, "· B 会话:", await evB("state.session?.sessionId?.slice(0,8)"));
console.log("A/B 独立:", await evA("state.session?.sessionId") !== await evB("state.session?.sessionId"));

// ---- B 换模型 + 发消息（与 A 并行）----
const bModels = await evB("state.models.length");
await evB(`(function(){ const sel=document.getElementById('model-select'); if(sel.options.length>2){ sel.selectedIndex = 0; sel.dispatchEvent(new Event('change')); } })()`);
await sleep(1500);
const bModel = await evB("state.session?.model?.id");
const aModel = await evA("state.session?.model?.id");
console.log(`A 模型: ${aModel} | B 模型: ${bModel} | 不同: ${aModel !== bModel}`);
await evB(`document.getElementById('input').value = ${JSON.stringify("只回复四个字：并行成功")}`);
await evB("document.getElementById('btn-send').click()");

// 等 B 完成
let bDone = false;
for (let i = 0; i < 60; i++) {
	await sleep(1500);
	if (!(await evB("state.streaming")) && (await evB("document.querySelectorAll('.msg').length")) >= 2) { bDone = true; break; }
}
console.log("B 完成:", bDone, "· A 仍在流式:", await evA("state.streaming"));
const bText = await evB(`[...document.querySelectorAll('.msg.assistant .body')].pop()?.textContent ?? ''`);
console.log("B 回复:", String(bText).slice(0, 50));

// ---- A 完成后：树导航补验 ----
for (let i = 0; i < 90; i++) {
	await sleep(1500);
	if (!(await evA("state.streaming"))) break;
}
console.log("A 完成 · 消息数:", await evA("document.querySelectorAll('.msg').length"));
await evA("document.getElementById('btn-tree').click()");
await sleep(1000);
const userNode = await evA(`[...document.querySelectorAll('.tree-node')].find(n=>n.textContent.includes('科幻'))?.dataset.id`);
console.log("树中找到 A 首条消息节点:", !!userNode);
if (userNode) {
	await evA(`[...document.querySelectorAll('.tree-node')].find(n=>n.dataset.id===${JSON.stringify(userNode)}).click()`);
	await sleep(5000);
	console.log("导航后消息数（重放）:", await evA("document.querySelectorAll('.msg').length"), "· 状态:", await evA("document.getElementById('status-left').textContent"));
}

// ---- B 里检查内核更新 ----
await evB("document.getElementById('btn-settings').click()");
await sleep(800);
await evB("document.getElementById('btn-check-updates').click()");
await sleep(12000);
console.log("内核检查:", await evB("document.getElementById('update-info').textContent"));

// 截图
const shotB = (await B.Page.captureScreenshot({ format: "png" })).data;
fs.writeFileSync("E:/pi2/openpi-desktop/m3-dist-proof-tmp.png", Buffer.from(shotB, "base64"));
const shotA = (await A.Page.captureScreenshot({ format: "png" })).data;
fs.writeFileSync("E:/pi2/openpi-desktop/m3-proof.png", Buffer.from(shotA, "base64"));
console.log("截图: m3-proof.png");
A.close();
B.close();
process.exit(0);
