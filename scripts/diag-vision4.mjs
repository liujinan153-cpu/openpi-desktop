import CDP from "chrome-remote-interface";
import fs from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = await CDP({ target: (await CDP.List({ port: 9333 })).find((t) => t.type === "page").webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = (x) => client.Runtime.evaluate({ expression: x, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => { if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? "").slice(0, 300)); return r.result.value; });
for (let i = 0; i < 30; i++) { await sleep(1500); if (await ev("state.session !== null && !state.streaming")) break; }
await ev(`(async()=>{
  modelSelect.value = 'my-proxy/agnes-3.0-flash';
  await window.openpi.setModel('my-proxy', 'agnes-3.0-flash');
})()`);
await sleep(1500);
const b64a = fs.readFileSync("C:/Users/admin/AppData/Roaming/pi-desktop/clipboard-images/pi-clipboard-ebd35abc-cb4a-44c0-b050-b4331119c3a2.png").toString("base64");
const b64b = fs.readFileSync("C:/Users/admin/AppData/Roaming/pi-desktop/clipboard-images/pi-clipboard-1fe51088-ebc2-4dbb-bc9e-a223a4fed457.png").toString("base64");
await ev(`(async()=>{
  state.images = [
    { data: ${JSON.stringify(b64a)}, mimeType: "image/png" },
    { data: ${JSON.stringify(b64b)}, mimeType: "image/png" }
  ];
  document.getElementById("input").value = "这两张截图里各有什么文字？把两张图中所有可读的英文/中文文字逐字列出来。";
  document.getElementById("btn-send").click();
})()`);
let got = "";
for (let i = 0; i < 60; i++) {
  await sleep(3000);
  const streaming = await ev("state.streaming");
  got = await ev("(function(){ const els=document.querySelectorAll('#chat .msg.assistant .md'); return els.length ? els[els.length-1].textContent : ''; })()");
  if (!streaming && got.length > 20) break;
}
console.log("====== Agnes 看图说话 ======");
console.log(got.slice(0, 3000));
client.close(); process.exit(0);
