/**
 * P1.5 E2E：终端 ↑↓ 历史 + 文件树自动刷新（fs.watch 真实改动）+ 审核角标联动
 */
import CDP from "chrome-remote-interface";
import fs from "node:fs";

const PORT = 9333;
const APP = "E:/pi2/openpi-desktop";

const connect = async () => {
	const tabs = await CDP.List({ port: PORT });
	const page = tabs.find((t) => t.type === "page");
	return CDP({ target: page.webSocketDebuggerUrl });
};
const ev = (client, expr) =>
	client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => {
		if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description ?? "").slice(0, 400));
		return r.result.value;
	});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (client, name) => {
	const r = await client.Page.captureScreenshot({ format: "png", fromSurface: true });
	fs.writeFileSync(`${APP}/p15-${name}.png`, Buffer.from(r.data, "base64"));
	console.log(`📸 p15-${name}.png`);
};
const runCmd = (client, cmd) =>
	ev(client, `(()=>{const i=document.getElementById('term-in'); i.value=${JSON.stringify(cmd)}; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',cancelable:true}))})()`);
const keyIn = (client, k) =>
	ev(client, `(()=>{const i=document.getElementById('term-in'); i.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},cancelable:true})); return i.value})()`);

const main = async () => {
	const client = await connect();
	await client.Runtime.enable();

	// ---- 1. 终端历史 ↑↓ ----
	console.log("== 1. 终端历史 ==");
	await ev(client, `showDock("terminal")`);
	await sleep(300);
	await runCmd(client, "echo hist-alpha");
	await sleep(2500); // 等命令结束
	await runCmd(client, "echo hist-beta");
	await sleep(2500);
	// ↑ → 应为 hist-beta；再 ↑ → hist-alpha；↓ → hist-beta；再 ↓ → 草稿（空）
	console.log("↑1:", await keyIn(client, "ArrowUp"), "| ↑2:", await keyIn(client, "ArrowUp"),
		"| ↓1:", await keyIn(client, "ArrowDown"), "| ↓2:", await keyIn(client, "ArrowDown"));
	console.log("localStorage 持久化:", await ev(client, `JSON.parse(localStorage.getItem('openpi-term-hist')||'[]').slice(-2)`));
	// 输入一半 ↑ → 草稿保留；↓ 回来
	await ev(client, `document.getElementById('term-in').value='draft-xyz'`);
	console.log("草稿→↑:", await keyIn(client, "ArrowUp"), "| ↓还原草稿:", await keyIn(client, "ArrowDown"));

	// ---- 2. 文件树自动刷新（Agent 之外的真实改动） ----
	console.log("== 2. 文件树自动刷新 ==");
	const ws = await ev(client, "state.session?.workspace");
	fs.mkdirSync(`${ws}/p1sub`, { recursive: true }); // 确保子目录存在
	await ev(client, `showDock("files")`);
	await sleep(1000);
	// 展开 p1sub
	await ev(client, `[...document.querySelectorAll('.f-node')].find(x => x.textContent.includes('p1sub'))?.click()`);
	await sleep(800);
	// 面板保持打开，外部直接写文件（模拟 Agent bash/edit 改动）
	fs.writeFileSync(`${ws}/p1b-fresh.txt`, "fresh\n");
	fs.writeFileSync(`${ws}/p1sub/p1b-nested.txt`, "nested-fresh\n");
	let found = false, foundNested = false;
	for (let n = 0; n < 12 && !(found && foundNested); n++) {
		await sleep(500);
		found = found || await ev(client, `[...document.querySelectorAll('.f-node')].some(x => x.textContent.includes('p1b-fresh.txt'))`);
		foundNested = foundNested || await ev(client, `[...document.querySelectorAll('.f-node')].some(x => x.textContent.includes('p1b-nested.txt'))`);
	}
	console.log("根目录新文件自动出现:", found, "| 展开的子目录新文件自动出现:", foundNested);
	console.log("p1sub 仍处于展开态:", await ev(client, `fstate.expanded.has('p1sub')`));
	await shot(client, "2-autorefresh");

	// ---- 3. 审核角标联动（fs:changed → scheduleReviewRefresh） ----
	console.log("== 3. 审核角标联动 ==");
	await sleep(2000); // 等 review 防抖+git status
	console.log("角标计数(应为3):", await ev(client, `document.getElementById('review-cnt').textContent`));

	// ---- 4. 快速灭源：删掉测试文件 → 树自动收敛 ----
	fs.unlinkSync(`${ws}/p1b-fresh.txt`);
	fs.unlinkSync(`${ws}/p1sub/p1b-nested.txt`);
	let gone = false;
	for (let n = 0; n < 12 && !gone; n++) {
		await sleep(500);
		gone = !(await ev(client, `[...document.querySelectorAll('.f-node')].some(x => x.textContent.includes('p1b-fresh.txt'))`));
	}
	console.log("删除后树自动收敛:", gone);
	console.log("== 完成 ==");
	process.exit(0);
};

main().catch((e) => { console.error("E2E 失败:", e.message); process.exit(1); });
