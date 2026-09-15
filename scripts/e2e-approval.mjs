/** 三档审批聚焦验证 */
import CDP from "chrome-remote-interface";
import fs from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = await CDP({ target: (await CDP.List({ port: 9333 })).find((t) => t.type === "page").webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = (x) => client.Runtime.evaluate({ expression: x, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => { if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? "").slice(0, 200)); return r.result.value; });
const waitIdle = async () => { for (let i = 0; i < 80; i++) { await sleep(1500); if (!(await ev("state.streaming"))) return; } };
const setMode = (m) => ev(`document.getElementById('approval-select').value='${m}'; document.getElementById('approval-select').dispatchEvent(new Event('change'));`);

for (let i = 0; i < 30; i++) { await sleep(1500); if (await ev("state.session !== null && !state.streaming")) break; }

// 切到 e2e 工作区
await ev(`window.openpi.newSession({ workspace: ${JSON.stringify("E:\\pi2\\openpi-desktop\\e2e-ws")} })`);
for (let i = 0; i < 30; i++) { await sleep(1500); if (await ev("state.session !== null && !state.streaming")) break; }
console.log("工作区:", await ev("state.session?.workspace"));

// ===== 只读档：write 应弹窗，拒绝 =====
await setMode("readonly");
await sleep(600);
console.log("档位:", await ev("window.openpi.getApprovalMode()"));
await ev(`document.getElementById('input').value = ${JSON.stringify("在工作区创建 z-ro.md 内容为 hi，用 write 工具。")}`);
await ev("document.getElementById('btn-send').click()");
let hit = false;
for (let i = 0; i < 50; i++) {
	await sleep(800);
	if (await ev(`!!document.querySelector('.modal-mask .ui-no')`)) {
		hit = true;
		console.log("只读档弹窗 ✓:", (await ev(`document.querySelector('.ui-msg')?.textContent`))?.slice(0, 60));
		await ev(`document.querySelector('.modal-mask .ui-no').click()`); // 拒绝
		break;
	}
}
await waitIdle();
fs.appendFileSync("E:/pi2/openpi-desktop/e2e-ws/.keep", "");
console.log("拒绝后 z-ro.md 存在(应false):", fs.existsSync("E:/pi2/openpi-desktop/e2e-ws/z-ro.md"));

// ===== 只读档：允许放行 =====
await ev(`document.getElementById('input').value = ${JSON.stringify("现在把 z-ok.md 创建出来，内容 ok，用 write 工具。")}`);
await ev("document.getElementById('btn-send').click()");
let hit2 = false;
for (let i = 0; i < 50; i++) {
	await sleep(800);
	if (await ev(`!!document.querySelector('.modal-mask .ui-no')`)) {
		hit2 = true;
		await ev(`document.querySelector('.modal-mask .ui-ok').click()`); // 允许
		break;
	}
}
console.log("只读档二次弹窗(应true):", hit2);
await waitIdle();
console.log("允许后 z-ok.md 存在(应true):", fs.existsSync("E:/pi2/openpi-desktop/e2e-ws/z-ok.md"));

// ===== 全自动档：危险 bash 直接跑，不弹窗 =====
await setMode("full-auto");
await sleep(600);
await ev(`document.getElementById('input').value = ${JSON.stringify("用 bash 执行: rm -f e2e-ws/z-ok.md && echo CLEANED，然后报告。")}`);
await ev("document.getElementById('btn-send').click()");
let popup = false;
for (let i = 0; i < 50; i++) {
	await sleep(800);
	if (await ev(`!!document.querySelector('.modal-mask .ui-no')`)) { popup = true; break; }
	if (i > 10 && !(await ev("state.streaming"))) break;
}
console.log("全自动档弹窗(应false):", popup);
await waitIdle();
console.log("全自动 rm 执行后 z-ok.md 存在(应false):", fs.existsSync("E:/pi2/openpi-desktop/e2e-ws/z-ok.md"));

// 恢复默认
await setMode("auto-edit");
const { data } = await client.Page.captureScreenshot({ format: "png" });
fs.writeFileSync("E:/pi2/openpi-desktop/m35-approval-proof.png", Buffer.from(data, "base64"));
console.log("截图: m35-approval-proof.png");
client.close();
process.exit(0);
