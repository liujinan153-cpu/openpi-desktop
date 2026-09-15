import CDP from "chrome-remote-interface";
import fs from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = await CDP({ target: (await CDP.List({ port: 9333 })).find((t) => t.type === "page").webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = (x) => client.Runtime.evaluate({ expression: x, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => { if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? "").slice(0, 200)); return r.result.value; });
for (let i = 0; i < 30; i++) { await sleep(1500); if (await ev("state.session !== null && !state.streaming")) break; }

// bash 输出渲染
await ev(`document.getElementById('input').value = ${JSON.stringify("用 bash 执行: echo HELLO_BASH_OUTPUT 并报告输出。")}`);
await ev("document.getElementById('btn-send').click()");
for (let i = 0; i < 60; i++) { await sleep(1500); if (!(await ev("state.streaming"))) break; }
const out = await ev(`[...document.querySelectorAll('.tool .out')].map(x=>x.textContent).join(' | ')`);
console.log("bash 卡输出:", String(out).slice(0, 100));
console.log("含[object Object](应false):", String(out).includes("[object Object]"));

// git diff 面板
await ev("document.getElementById('btn-git').click()");
await sleep(1200);
await ev("document.querySelector('.git-file').click()");
await sleep(2500);
console.log("diff 内容非空:", await ev(`!!document.querySelector('.git-pre:not([hidden])')?.textContent`));
const { data } = await client.Page.captureScreenshot({ format: "png" });
fs.writeFileSync("E:/pi2/openpi-desktop/m35-proof.png", Buffer.from(data, "base64"));
console.log("截图: m35-proof.png");
client.close();
process.exit(0);
