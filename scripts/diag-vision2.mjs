import CDP from "chrome-remote-interface";
import fs from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = await CDP({ target: (await CDP.List({ port: 9333 })).find((t) => t.type === "page").webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = (x) => client.Runtime.evaluate({ expression: x, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => { if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? "").slice(0, 300)); return r.result.value; });
for (let i = 0; i < 30; i++) { await sleep(1500); if (await ev("state.session !== null && !state.streaming")) break; }
// 换 gemini-3.8-flash（图像能力更强），重置旧对话避免旧上下文干扰
await ev(`(async()=>{
  modelSelect.value = 'my-proxy-2/gemini-3.8-flash';
  await window.openpi.newSession({ provider: 'my-proxy-2', id: 'gemini-3.8-flash' });
  state.session = await window.openpi.getMessages ? null : state.session;
  location.reload();
})()`);
await sleep(12000);
for (let i = 0; i < 30; i++) { await sleep(1500); if (await ev("state.session !== null && !state.streaming")) break; }
console.log("当前模型:", await ev("state.session?.model?.id"));
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
  got = await ev("document.querySelectorAll('#chat .msg.assistant .md').length ? document.querySelectorAll('#chat .msg.assistant .md')[document.querySelectorAll('#chat .msg.assistant .md').length-1].textContent : ''");
  if (!streaming && got.length > 30) break;
}
console.log("====== gemini 转述 ======");
console.log(got.slice(0, 2500));
client.close(); process.exit(0);
