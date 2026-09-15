/**
 * P1 E2E：右侧面板开关（右上角）+ 终端标签 + 文件标签 + 快捷键
 */
import CDP from "chrome-remote-interface";
import fs from "node:fs";

const PORT = 9333;
const APP = "E:/pi2/openpi-desktop";

const connect = async () => {
	const tabs = await CDP.List({ port: PORT });
	const page = tabs.find((t) => t.type === "page");
	if (!page) throw new Error("no page target");
	return CDP({ target: page.webSocketDebuggerUrl });
};
const ev = (client, expr) =>
	client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => {
		if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description ?? "").slice(0, 400));
		return r.result.value;
	});
const key = (client, modifiers, k, code, vk) =>
	client.Input.dispatchKeyEvent({ type: "rawKeyDown", modifiers, key: k, code, windowsVirtualKeyCode: vk })
		.then(() => client.Input.dispatchKeyEvent({ type: "keyUp", modifiers, key: k, code, windowsVirtualKeyCode: vk }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (client, name) => {
	const r = await client.Page.captureScreenshot({ format: "png", fromSurface: true });
	fs.writeFileSync(`${APP}/p1-${name}.png`, Buffer.from(r.data, "base64"));
	console.log(`📸 p1-${name}.png`);
};

const main = async () => {
	const client = await connect();
	await client.Runtime.enable();
	await client.Page.enable();

	// ---- 0. 准备工作区测试文件 ----
	const ws = await ev(client, "state.session?.workspace");
	console.log("工作区:", ws);
	fs.mkdirSync(`${ws}/p1sub`, { recursive: true });
	fs.writeFileSync(`${ws}/p1demo.txt`, "alpha\nbeta\n");
	fs.writeFileSync(`${ws}/p1sub/nested.md`, "# nested\n");

	// ---- 1. 右上角面板开关 ----
	console.log("== 1. 面板开关 ==");
	console.log("初始隐藏:", await ev(client, "document.getElementById('dock').hidden"));
	await ev(client, `showDock("review")`); // 打开并固定到 review
	await sleep(300);
	await ev(client, `document.getElementById('btn-dock').click()`); // 关闭
	console.log("点击后隐藏:", await ev(client, "document.getElementById('dock').hidden"));
	await ev(client, `document.getElementById('btn-dock').click()`); // 再开 → 恢复 review
	await sleep(800);
	console.log("再点后恢复review:", await ev(client, "!document.getElementById('dock').hidden && !document.getElementById('dock-pane-review').hidden"));

	// ---- 2. 终端标签 ----
	console.log("== 2. 终端 ==");
	await ev(client, `showDock("terminal")`);
	await sleep(300);
	console.log("cwd显示:", await ev(client, "document.getElementById('term-cwd').textContent"));
	await ev(client, `(()=>{const i=document.getElementById('term-in'); i.value='echo hello-p1'; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',cancelable:true}))})()`);
	let ok = false;
	for (let n = 0; n < 20 && !ok; n++) {
		await sleep(500);
		ok = await ev(client, `document.getElementById('term-out').textContent.includes('hello-p1') && document.getElementById('term-out').textContent.includes('进程退出')`);
	}
	console.log("echo 输出+退出码:", ok);
	console.log("停止钮已复位:", await ev(client, "document.getElementById('term-stop').hidden"));

	// 长命令 + 终止
	await ev(client, `(()=>{const i=document.getElementById('term-in'); i.value='ping -n 30 127.0.0.1'; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',cancelable:true}))})()`);
	await sleep(2000);
	console.log("长命令运行中(停止钮可见):", await ev(client, "!document.getElementById('term-stop').hidden"));
	await ev(client, `document.getElementById('term-stop').click()`);
	let killed = false;
	for (let n = 0; n < 10 && !killed; n++) { await sleep(500); killed = await ev(client, "document.getElementById('term-stop').hidden"); }
	console.log("终止成功:", killed);
	await shot(client, "2-terminal");

	// ---- 3. 文件标签 ----
	console.log("== 3. 文件 ==");
	await ev(client, `showDock("files")`);
	await sleep(1200);
	console.log("根节点数:", await ev(client, "document.querySelectorAll('#files-tree .f-node').length"));
	// 展开 p1sub
	await ev(client, `[...document.querySelectorAll('.f-node')].find(x => x.textContent.includes('p1sub')).click()`);
	await sleep(800);
	console.log("展开后出现 nested.md:", await ev(client, "[...document.querySelectorAll('.f-node')].some(x => x.textContent.includes('nested.md'))"));
	// 点文件预览
	await ev(client, `[...document.querySelectorAll('.f-node')].find(x => x.textContent.includes('nested.md')).click()`);
	await sleep(800);
	console.log("预览路径:", await ev(client, "document.getElementById('fv-path').textContent"));
	console.log("预览内容含nested:", await ev(client, "document.getElementById('files-view').textContent.includes('nested')"));
	await shot(client, "3-fileview");
	await ev(client, `document.getElementById('fv-back').click()`);
	// 搜索
	await ev(client, `const f=document.getElementById('files-filter'); f.value='p1demo'; f.dispatchEvent(new Event('input'))`);
	await sleep(1000);
	console.log("搜索到 p1demo.txt:", await ev(client, "[...document.querySelectorAll('.f-node')].some(x => x.textContent.includes('p1demo.txt'))"));
	await shot(client, "3-search");

	// ---- 4. 快捷键 ----
	console.log("== 4. 快捷键 ==");
	// Ctrl+Alt+B 关/开面板（CDP 对 Ctrl+Alt 组合注入在 Windows 上不可靠，用合成事件）
	await ev(client, `document.dispatchEvent(new KeyboardEvent('keydown',{key:'b',ctrlKey:true,altKey:true,cancelable:true})) && 'ok'`);
	await sleep(400);
	console.log("Ctrl+Alt+B 关闭:", await ev(client, "document.getElementById('dock').hidden"));
	await ev(client, `document.dispatchEvent(new KeyboardEvent('keydown',{key:'b',ctrlKey:true,altKey:true,cancelable:true})) && 'ok'`);
	await sleep(400);
	console.log("Ctrl+Alt+B 再开(恢复files):", await ev(client, "!document.getElementById('dock').hidden && !document.getElementById('dock-pane-files').hidden"));
	// Ctrl+P → 文件 + 焦点（modifiers: 2）
	await key(client, 2, "p", "KeyP", 80);
	await sleep(400);
	console.log("Ctrl+P 打开文件且聚焦:", await ev(client, "!document.getElementById('dock-pane-files').hidden && document.activeElement === document.getElementById('files-filter')"));
	// Ctrl+T → 预览
	await key(client, 2, "t", "KeyT", 84);
	await sleep(400);
	console.log("Ctrl+T 切预览:", await ev(client, "!document.getElementById('dock-pane-preview').hidden"));
	console.log("== 完成 ==");
	process.exit(0);
};

main().catch((e) => { console.error("E2E 失败:", e.message); process.exit(1); });
