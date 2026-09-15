import CDP from "chrome-remote-interface";
import fs from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = await CDP({ target: (await CDP.List({ port: 9333 })).find((t) => t.type === "page").webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = (x) => client.Runtime.evaluate({ expression: x, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => { if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? "").slice(0, 300)); return r.result.value; });
for (let i = 0; i < 30; i++) { await sleep(1500); if (await ev("state.session !== null && !state.streaming")) break; }
await ev(`(async()=>{ modelSelect.value = 'my-proxy/agnes-3.0-flash'; await window.openpi.setModel('my-proxy','agnes-3.0-flash'); })()`);
await sleep(1500);
// 让 Agnes 用自己的 read 工具读图（它声称支持 png）
await ev(`(async()=>{
  document.getElementById("input").value = "请用你的 read 工具依次读取以下两个文件，然后分别描述：1) C:/Users/admin/AppData/Roaming/pi-desktop/clipboard-images/pi-clipboard-ebd35abc-cb4a-44c0-b050-b4331119c3a2.png 2) 同目录 pi-clipboard-1fe51088-ebc2-4dbb-bc9e-a223a4fed457.png。每张图：什么产品、什么界面、哪些设计可借鉴。分两段。";
  document.getElementById("btn-send").click();
})()`);
let got = "";
for (let i = 0; i < 120; i++) {
  await sleep(3000);
  const streaming = await ev("state.streaming");
  got = await ev("(function(){ const els=document.querySelectorAll('#chat .msg.assistant .md'); return els.length ? els[els.length-1].textContent : ''; })()");
  if (!streaming && got.length > 30) break;
}
console.log("====== Agnes read工具读图 ======");
console.log(got.slice(0, 3000));
client.close(); process.exit(0);
