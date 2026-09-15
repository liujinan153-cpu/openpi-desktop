/** E2E-9: 打包版 0.4.0 冒烟 —— M3 新窗口按钮 + 并行 */
import CDP from "chrome-remote-interface";
import fs from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkEv = (c) => (x) =>
	c.Runtime.evaluate({ expression: x, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => {
		if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? "").slice(0, 250));
		return r.result.value;
	});

let client = await CDP({ target: (await CDP.List({ port: 9334 })).find((t) => t.type === "page").webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = mkEv(client);
for (let i = 0; i < 30; i++) { await sleep(1500); if (await ev("state.session !== null")) break; }
console.log("版本:", await ev("document.getElementById('version-badge')?.textContent"));
console.log("⧉ 新窗口按钮:", await ev("!!document.getElementById('btn-newwin')"));
await ev("document.getElementById('btn-newwin').click()");
await sleep(7000);
const tabs = (await CDP.List({ port: 9334 })).filter((t) => t.type === "page");
console.log("窗口数:", tabs.length);
await ev("window.__IS_A=1"); const other = tabs.find(t => !t.url.includes("done"));
let c2 = null;
for (const t of tabs) { const c = await CDP({ target: t.webSocketDebuggerUrl }); await c.Runtime.enable(); const isA = await c.Runtime.evaluate({expression:"!!window.__IS_A",returnByValue:true}).then(r=>r.result.value); if (!isA) { c2 = c; break; } await c.close(); }
await c2.Runtime.enable();
for (let i = 0; i < 30; i++) {
	await sleep(1500);
	if ((await mkEv(c2)("typeof state!=='undefined' && state.session!==null")) === true) break;
}
const ev2 = mkEv(c2);
console.log("窗口B 会话:", (await ev2("state.session?.sessionId"))?.slice(0, 8), "· A/B 独立:", (await ev("state.session?.sessionId")) !== (await ev2("state.session?.sessionId")));
// B 里并行发一条
await ev2(`document.getElementById('input').value = ${JSON.stringify("只回复：打包版并行OK")}`);
await ev2("document.getElementById('btn-send').click()");
for (let i = 0; i < 60; i++) { await sleep(1500); if (!(await ev2("state.streaming"))) break; }
console.log("B 回复:", String(await ev2(`[...document.querySelectorAll('.msg.assistant .body')].pop()?.textContent ?? ''`)).slice(0, 40));
const { data } = await client.Page.captureScreenshot({ format: "png" });
fs.writeFileSync("E:/pi2/openpi-desktop/m3-dist-proof.png", Buffer.from(data, "base64"));
console.log("截图: m3-dist-proof.png");
client.close(); c2.close();
process.exit(0);
