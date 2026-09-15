/** E2E-10: M3.5 —— 审批三档 / git 面板 / 图片输入 */
import CDP from "chrome-remote-interface";
import fs from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = await CDP({ target: (await CDP.List({ port: 9333 })).find((t) => t.type === "page").webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = (expr) =>
	client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => {
		if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description ?? "").slice(0, 250));
		return r.result.value;
	});
const waitIdle = async () => { for (let i = 0; i < 60; i++) { await sleep(1500); if (!(await ev("state.streaming"))) return; } };
const pngB64 = fs.readFileSync("E:/pi2/openpi-desktop/e2e-ws/logo.png").toString("base64");

for (let i = 0; i < 30; i++) { await sleep(1500); if (await ev("state.session !== null && !state.streaming")) break; }

// 切到 git 测试工作区
await ev(`window.openpi.newSession({ workspace: ${JSON.stringify("E:\\pi2\\openpi-desktop\\e2e-ws")} })`);
for (let i = 0; i < 30; i++) { await sleep(1500); if (await ev("state.session !== null && !state.streaming")) break; }
console.log("工作区:", await ev("state.session?.workspace"));

// ===== 1) git 面板：状态/diff/提交 =====
await ev("document.getElementById('btn-git').click()");
await sleep(1200);
console.log("git 分支行:", await ev(`document.querySelector('.git-branch')?.textContent`));
console.log("git 变更文件数:", await ev("document.querySelectorAll('.git-file').length"));
await ev("document.querySelector('.git-file').click()"); // 展开第一个 diff
await sleep(1500);
const diffHead = await ev(`document.querySelector('.git-pre:not([hidden])')?.textContent?.split('\\n').slice(0,4).join(' | ')`);
console.log("diff 首行:", String(diffHead).slice(0, 90));
await ev(`document.getElementById('git-msg').value = ${JSON.stringify("E2E: 修改 a.md b.js 新增 c.txt")}`);
await ev("document.getElementById('git-do-commit').click()");
await sleep(2500);
console.log("提交后变更数:", await ev("document.querySelectorAll('.git-file').length"), "· log 含 E2E:", await ev(`document.body.querySelector('.git-pre.dim')?.textContent.includes('E2E:')`));
await ev("document.querySelector('.git-close').click()");

// ===== 2) 图片输入：直接注入 state.images 并发送 =====
await ev(`state.images.push({ data: ${JSON.stringify(pngB64)}, mimeType: "image/png" }); renderImageBar();`);
console.log("图片条显示:", await ev("!document.getElementById('img-bar').hidden"), "· 缩略图:", await ev("document.querySelectorAll('.img-chip').length"));
await ev(`document.getElementById('input').value = ${JSON.stringify("这张图片是什么颜色？只回复颜色名。")}`);
await ev("document.getElementById('btn-send').click()");
await waitIdle();
const ans = await ev(`[...document.querySelectorAll('.msg.assistant .body')].pop()?.textContent ?? ''`);
console.log("图片问答:", String(ans).slice(0, 60).replace(/\n/g, " "));
console.log("用户气泡含图:", await ev(`[...document.querySelectorAll('.msg.user .imgs')].length > 0`));

// ===== 3) 审批三档 =====
// 3a) 全自动：危险命令直接放行
await ev(`document.getElementById('approval-select').value='full-auto'; document.getElementById('approval-select').dispatchEvent(new Event('change'));`);
await sleep(500);
await ev(`document.getElementById('input').value = ${JSON.stringify("用 bash 执行: echo FULLAUTO && echo done")}`);
await ev("document.getElementById('btn-send').click()");
let popup = false;
const dl = Date.now() + 60000;
while (Date.now() < dl) { await sleep(800); if (await ev(`!!document.querySelector('.modal-mask .ui-no')`)) { popup = true; break; } if (!(await ev("state.streaming")) && Date.now() > dl - 55000) break; }
console.log("全自动档弹窗(应false):", popup);
await waitIdle();

// 3b) 只读档：写文件被拦
await ev(`document.getElementById('approval-select').value='readonly'; document.getElementById('approval-select').dispatchEvent(new Event('change'));`);
await sleep(500);
await ev(`document.getElementById('input').value = ${JSON.stringify("在工作区创建 d.md 内容为 hi，用 write 工具。")}`);
await ev("document.getElementById('btn-send').click()");
let roHit = false;
const dl2 = Date.now() + 90000;
while (Date.now() < dl2) {
	await sleep(800);
	if (await ev(`!!document.querySelector('.modal-mask .ui-no')`)) { roHit = true; console.log("只读档拦截弹窗 ✓:", (await ev("document.querySelector('.ui-msg')?.textContent"))?.slice(0, 50)); await ev("document.querySelector('.modal-mask .ui-ok').click()"); break; }
}
console.log("只读档拦截(应true):", roHit);
// 点掉可能后续的 bash 审批
const dl3 = Date.now() + 30000;
while (Date.now() < dl3) { await sleep(800); if (await ev(`!!document.querySelector('.modal-mask .ui-no')`)) await ev("document.querySelector('.modal-mask .ui-ok').click()"); if (!(await ev("state.streaming"))) break; }
await waitIdle();

// 恢复默认档
await ev(`document.getElementById('approval-select').value='auto-edit'; document.getElementById('approval-select').dispatchEvent(new Event('change'));`);
const { data } = await client.Page.captureScreenshot({ format: "png" });
fs.writeFileSync("E:/pi2/openpi-desktop/m35-proof.png", Buffer.from(data, "base64"));
console.log("截图: m35-proof.png");
client.close();
process.exit(0);
