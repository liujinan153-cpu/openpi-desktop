/** E2E-6: 补验 导出HTML / 改名 / 压缩（class 是 .sysline 不是 .sys） */
import CDP from "chrome-remote-interface";

const client = await CDP({ target: (await CDP.List({ port: 9333 })).find((t) => t.type === "page").webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = (expr) =>
	client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => {
		if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description ?? "").slice(0, 300));
		return r.result.value;
	});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastSys = () => ev(`[...document.querySelectorAll('.sysline')].pop()?.textContent ?? ''`);

console.log("== 导出 HTML ==");
await ev("document.getElementById('btn-export').click()");
await sleep(8000);
console.log((await lastSys()).slice(0, 150));

console.log("== 改名 ==");
await ev("document.getElementById('btn-rename').click()");
await sleep(500);
await ev(`document.querySelector('.ui-in').value = 'M2-E2E-测试会话'`);
await ev(`document.querySelector('.modal-mask .ui-ok').click()`);
await sleep(2500);
console.log((await lastSys()).slice(0, 90));
console.log("侧栏第一条:", (await ev(`document.querySelector('.s-item .s-preview')?.textContent`))?.slice(0, 40));

console.log("== 手动压缩 ==");
await ev("document.getElementById('btn-compact').click()");
for (let i = 0; i < 25; i++) {
	await sleep(2000);
	const t = await lastSys();
	if (t.includes("压缩完成") || t.includes("失败")) { console.log(t.slice(0, 130)); break; }
}
console.log("上下文条:", await ev(`document.getElementById('ctx-bar').style.width`), await ev(`document.getElementById('ctx-bar').title`));
client.close();
process.exit(0);
