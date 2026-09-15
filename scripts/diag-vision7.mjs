import CDP from "chrome-remote-interface";
import fs from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = await CDP({ target: (await CDP.List({ port: 9333 })).find((t) => t.type === "page").webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = (x) => client.Runtime.evaluate({ expression: x, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => { if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? "").slice(0, 300)); return r.result.value; });
for (let i = 0; i < 30; i++) { await sleep(1500); if (await ev("state.session !== null && !state.streaming")) break; }
await ev(`(async()=>{ modelSelect.value = 'my-proxy/agnes-3.0-flash'; await window.openpi.setModel('my-proxy','agnes-3.0-flash'); })()`);
await sleep(1500);
// 直接调 window.openpi.prompt（不经过 app.js 的 send，避免任何过滤层）
const b64a = fs.readFileSync("C:/Users/admin/AppData/Roaming/pi-desktop/clipboard-images/pi-clipboard-ebd35abc-cb4a-44c0-b050-b4331119c3a2.png").toString("base64");
await ev(`(async()=>{
  await window.openpi.prompt("请用 read 工具读取 ${JSON.stringify("C:/Users/admin/AppData/Roaming/pi-desktop/clipboard-images/pi-clipboard-ebd35abc-cb4a-44c0-b050-b4331119c3a2.png")} 这张图片并描述它的内容：什么产品、什么界面、有哪些UI元素。", [{ data: "test-忽略-base64", mimeType: "image/png" }]);
})()`);
let got = "";
for (let i = 0; i < 60; i++) {
  await sleep(3000);
  const streaming = await ev("state.streaming");
  got = await ev("(function(){ const els=document.querySelectorAll('#chat .msg.assistant .md'); return els.length ? els[els.length-1].textContent : ''; })()");
  if (!streaming && got.length > 30) break;
}
console.log("====== 直调 prompt ======");
console.log(got.slice(0, 1500));
client.close(); process.exit(0);
