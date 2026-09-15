// E2E P19：预览 pane = 内置浏览器
// 用法：先启动 electron --remote-debugging-port=9333，再 node scripts/e2e-p19.mjs
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const WS = path.join(os.homedir(), "openpi-workspace");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (client, name) => {
	const r = await client.Page.captureScreenshot({ format: "png", fromSurface: true });
	fs.writeFileSync(`p19-${name}.png`, Buffer.from(r.data, "base64"));
	console.log(`📸 p19-${name}.png`);
};

// 造两个测试生成物
fs.writeFileSync(path.join(WS, "p19-demo.html"), "<h1 id='t'>P19 内置浏览器 OK</h1><script>document.title='p19-demo'</script>");
fs.writeFileSync(path.join(WS, "p19-page2.html"), "<h1>PAGE2</h1>");

const client = await (async () => {
	const tabs = await CDP.List({ port: 9333 });
	const page = tabs.find((t) => t.type === "page");
	return CDP({ target: page.webSocketDebuggerUrl });
})();
await client.Runtime.enable();
await client.Page.enable();
const ev = async (expr) => {
	const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.slice(0, 400));
	return r.result.value;
};

console.log("== 1. 地址规范化 ==");
console.log("win路径→file:", await ev(`normalizeUrl("C:\\\\Users\\\\a\\\\demo.html")`));
console.log("localhost→http:", await ev(`normalizeUrl("localhost:3000")`));
console.log("裸域名→https:", await ev(`normalizeUrl("example.com")`));
console.log("相对名→工作区:", await ev(`startSession(${JSON.stringify(WS)}), new Promise(r=>setTimeout(r,2500)).then(()=>normalizeUrl("p19-demo.html"))`));

console.log("== 2. 地址栏回车导航 ==");
await ev(`(function(){ const i=document.getElementById("pv-url"); i.value="p19-demo.html"; i.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",cancelable:true})); })()`);
await sleep(1500);
console.log("webview src:", await ev(`document.getElementById("pv-webview").getAttribute("src")`));
console.log("地址栏回显:", await ev(`document.getElementById("pv-url").value`));
await shot(client, "browser");

console.log("== 3. 后退/前进 + chips ==");
await ev(`navTo("p19-page2.html")`);
await sleep(1200);
console.log("导航到第2页:", await ev(`document.getElementById("pv-webview").getAttribute("src")`));
await ev(`document.getElementById("pv-back").click()`);
await sleep(1200);
console.log("后退→第1页:", await ev(`document.getElementById("pv-webview").getAttribute("src")`));
console.log("后退按钮禁用:", await ev(`document.getElementById("pv-back").disabled`));
await ev(`document.getElementById("pv-fwd").click()`);
await sleep(1200);
console.log("前进→第2页:", await ev(`document.getElementById("pv-webview").getAttribute("src")`));
console.log("chips条数:", await ev(`document.querySelectorAll(".pv-chip").length`));

console.log("== 4. Agent 输出探测生成物 → 自动打开 ==");
await ev(`toggleDock("preview")`);
await sleep(400);
await ev(`maybeDetectPreview("已创建 ${WS.replace(/\\/g, "\\\\")}\\\\p19-demo.html 供查看")`);
await sleep(1000);
console.log("Dock自动弹预览:", await ev(`!document.getElementById("dock").hidden && !document.getElementById("dock-pane-preview").hidden`));
console.log("当前src:", await ev(`document.getElementById("pv-webview").getAttribute("src")`));

console.log("== 5. 文件 tab 🌐 按钮 ==");
await ev(`showDock("files")`);
await sleep(600);
await ev(`openFileView("p19-demo.html")`);
await sleep(500);
console.log("fv-preview可见:", await ev(`!document.getElementById("fv-preview").hidden`));
await ev(`document.getElementById("fv-preview").click()`);
await sleep(1000);
console.log("跳到预览tab:", await ev(`!document.getElementById("dock-pane-preview").hidden`));
console.log("src为工作区文件:", await ev(`document.getElementById("pv-webview").getAttribute("src").includes("p19-demo.html")`));
await shot(client, "files-preview");

console.log("== 完成 ==");
process.exit(0);
