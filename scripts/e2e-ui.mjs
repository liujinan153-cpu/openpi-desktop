/** UI 升级截图验证 */
import CDP from "chrome-remote-interface";
import fs from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = await CDP({ target: (await CDP.List({ port: 9333 })).find((t) => t.type === "page").webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = (x) => client.Runtime.evaluate({ expression: x, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => { if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? "").slice(0, 250)); return r.result.value; });
const shot = async (name) => {
	const { data } = await client.Page.captureScreenshot({ format: "png" });
	fs.writeFileSync(`E:/pi2/openpi-desktop/${name}`, Buffer.from(data, "base64"));
	console.log("截图:", name);
};
for (let i = 0; i < 30; i++) { await sleep(1500); if (await ev("state.session !== null && !state.streaming")) break; }

// 1) 欢迎屏（新会话空状态）
await ev("window.openpi.newSession({})");
for (let i = 0; i < 25; i++) { await sleep(1500); if (await ev("state.session !== null && !state.streaming")) break; }
await sleep(1500);
console.log("欢迎屏显示:", await ev("!!document.getElementById('welcome')"));
await shot("ui-1-welcome.png");

// 2) 点示例任务 → 填入输入框
await ev("document.querySelector('.w-task').click()");
await sleep(600);
console.log("示例任务填入:", (await ev("document.getElementById('input').value")).slice(0, 20));
// 发送产生对话与工具卡
await ev(`document.getElementById('input').value = ${JSON.stringify("用 bash 工具执行: echo UI-UPGRADE-TEST ，然后简单说明工具卡的作用。")}`);
await ev("document.getElementById('btn-send').click()");
for (let i = 0; i < 70; i++) { await sleep(1500); if (!(await ev("state.streaming")) && i > 8) break; }
await sleep(1500);
await shot("ui-2-chat.png");

// 3) 亮色主题
await ev("document.getElementById('btn-theme').click()");
await sleep(600);
console.log("亮色主题:", await ev("document.documentElement.dataset.theme"));
await shot("ui-4-light.png");
await ev("document.getElementById('btn-theme').click()");
// 4) git 面板视觉（暗色）
await ev("document.getElementById('btn-git').click()");
await sleep(1500);
await shot("ui-3-git.png");
await ev("document.querySelector('.git-close').click()");
client.close();
process.exit(0);
