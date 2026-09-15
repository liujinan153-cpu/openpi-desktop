import CDP from "chrome-remote-interface";
import fs from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = await CDP({ target: (await CDP.List({ port: 9333 })).find((t) => t.type === "page").webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = (x) => client.Runtime.evaluate({ expression: x, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => { if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? "").slice(0, 300)); return r.result.value; });
for (let i = 0; i < 30; i++) { await sleep(1500); if (await ev("state.session !== null && !state.streaming")) break; }
// 用 Agnes 3.0 Flash
await ev(`(async()=>{
  modelSelect.value = 'my-proxy/agnes-3.0-flash';
  await window.openpi.setModel('my-proxy', 'agnes-3.0-flash');
  await window.openpi.newSession({ provider: 'my-proxy', id: 'agnes-3.0-flash' });
})()`);
await sleep(2000);
console.log("当前模型:", await ev("modelSelect.value"));
const b64a = fs.readFileSync("C:/Users/admin/AppData/Roaming/pi-desktop/clipboard-images/pi-clipboard-ebd35abc-cb4a-44c0-b050-b4331119c3a2.png").toString("base64");
const b64b = fs.readFileSync("C:/Users/admin/AppData/Roaming/pi-desktop/clipboard-images/pi-clipboard-1fe51088-ebc2-4dbb-bc9e-a223a4fed457.png").toString("base64");
await ev(`(async()=>{
  state.images = [
    { data: ${JSON.stringify(b64a)}, mimeType: "image/png" },
    { data: ${JSON.stringify(b64b)}, mimeType: "image/png" }
  ];
  document.getElementById("input").value = "我附了2张截图。请分别描述：第一张是什么产品/什么界面/哪些设计可借鉴；第二张同样。分两段，简洁。";
  document.getElementById("btn-send").click();
})()`);
let got = "";
for (let i = 0; i < 60; i++) {
  await sleep(3000);
  const streaming = await ev("state.streaming");
  const n = await ev("document.querySelectorAll('#chat .msg.assistant .md').length");
  got = await ev("document.querySelectorAll('#chat .msg.assistant .md')[" + 0 + "]?.textContent ?? ''");
  // 取最后一条 assistant 的 md
  got = await ev("(function(){ const els=document.querySelectorAll('#chat .msg.assistant .md'); return els.length ? els[els.length-1].textContent : ''; })()");
  if (!streaming && got.length > 20) break;
}
console.log("====== Agnes 3.0 Flash 转述 ======");
console.log(got.slice(0, 3000));
client.close(); process.exit(0);
