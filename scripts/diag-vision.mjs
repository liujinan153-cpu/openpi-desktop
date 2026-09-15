import CDP from "chrome-remote-interface";
import fs from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = await CDP({ target: (await CDP.List({ port: 9333 })).find((t) => t.type === "page").webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = (x) => client.Runtime.evaluate({ expression: x, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => { if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? "").slice(0, 300)); return r.result.value; });
for (let i = 0; i < 30; i++) { await sleep(1500); if (await ev("state.session !== null && !state.streaming")) break; }
// 切到支持图像的模型
await ev(`(async()=>{ modelSelect.value = 'zhipu/glm-5.3-flash'; state.session = await window.openpi.setModel('zhipu','glm-5.3-flash'); })()`);
await sleep(1500);
const b64a = fs.readFileSync("C:/Users/admin/AppData/Roaming/pi-desktop/clipboard-images/pi-clipboard-ebd35abc-cb4a-44c0-b050-b4331119c3a2.png").toString("base64");
const b64b = fs.readFileSync("C:/Users/admin/AppData/Roaming/pi-desktop/clipboard-images/pi-clipboard-1fe51088-ebc2-4dbb-bc9e-a223a4fed457.png").toString("base64");
await ev(`(async()=>{
  state.images = [
    { data: ${JSON.stringify(b64a)}, mimeType: "image/png" },
    { data: ${JSON.stringify(b64b)}, mimeType: "image/png" }
  ];
  document.getElementById("input").value = "你收到了两张截图。请分别描述：第一张是什么产品、什么界面、有哪些UI/功能设计值得借鉴；第二张同样。简洁分两段。";
  document.getElementById("btn-send").click();
})()`);
let got = "";
for (let i = 0; i < 60; i++) {
  await sleep(3000);
  const streaming = await ev("state.streaming");
  const els = await ev("document.querySelectorAll('#chat .msg.assistant .md').length");
  got = await ev("document.querySelectorAll('#chat .msg.assistant .md')[document.querySelectorAll('#chat .msg.assistant .md').length-1]?.textContent ?? ''");
  if (!streaming && got.length > 30) break;
}
console.log("====== 视觉模型转述 ======");
console.log(got.slice(0, 2500));
client.close(); process.exit(0);
