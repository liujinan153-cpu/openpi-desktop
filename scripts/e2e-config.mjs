/** E2E-3: 配置中心验证（设置弹窗 / 三个 Tab / 连通测试 / Ollama 预设） */
import CDP from "chrome-remote-interface";
import fs from "node:fs";

const connect = async () => {
	const tabs = await CDP.List({ port: 9333 });
	const page = tabs.find((t) => t.type === "page");
	return CDP({ target: page.webSocketDebuggerUrl });
};
const ev = (client, expr) =>
	client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => {
		if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description ?? "").slice(0, 300));
		return r.result.value;
	});

const main = async () => {
	const client = await connect();
	await client.Runtime.enable();

	// 等待应用就绪
	for (let i = 0; i < 20; i++) {
		await new Promise((r) => setTimeout(r, 1500));
		if ((await ev(client, "state.session !== null")) === true) break;
	}

	// 1. 打开设置
	await ev(client, "document.getElementById('btn-settings').click()");
	await new Promise((r) => setTimeout(r, 1200));
	console.log("== Tab1 API密钥 ==");
	console.log("密钥条目:", await ev(client, `document.querySelectorAll('#key-list .kv-item').length`));
	const keyRows = await ev(client, `[...document.querySelectorAll('#key-list .kv-item')].map(x=>x.textContent.replace(/\\s+/g,' ').trim()).join(' | ')`);
	console.log(String(keyRows).slice(0, 500));

	// 2. Tab2 自定义供应商：载入 zhipu 表单 → 测连通（真实密钥解析）
	console.log("== Tab2 自定义供应商 ==");
	await ev(client, `document.querySelector('#provider-list .kv-item').click()`);
	await new Promise((r) => setTimeout(r, 300));
	console.log("表单 baseUrl:", await ev(client, `document.getElementById('fp-baseurl').value`));
	await ev(client, `document.getElementById('btn-test-endpoint').click()`);
	await new Promise((r) => setTimeout(r, 3000));
	console.log("测连通结果:", await ev(client, `document.getElementById('fp-msg').textContent`));

	// 3. Tab3 本地模型预设（Ollama 大概率未启动 → 验证错误路径）
	console.log("== Tab3 本地模型 ==");
	await ev(client, `document.querySelector('.tab[data-tab="local"]').click()`);
	await new Promise((r) => setTimeout(r, 300));
	console.log("预设卡数量:", await ev(client, `document.querySelectorAll('.preset-card').length`));
	await ev(client, `document.querySelectorAll('.preset-card')[0].click()`); // Ollama
	await new Promise((r) => setTimeout(r, 3500));
	console.log("预设结果:", await ev(client, `document.getElementById('preset-msg').textContent`));
	console.log("切到供应商Tab后 baseUrl:", await ev(client, `document.getElementById('fp-baseurl').value`));
	console.log("compat 勾选:", await ev(client, `[document.getElementById('fp-devrole').checked, document.getElementById('fp-effort').checked]`));

	// 4. 截图（当前停在供应商Tab，表单已被 Ollama 预设填充）
	const { data } = await client.Page.captureScreenshot({ format: "png" });
	fs.writeFileSync("E:/pi2/openpi-desktop/m1-config-proof.png", Buffer.from(data, "base64"));
	console.log("截图: m1-config-proof.png");

	client.close();
	process.exit(0);
};

main().catch((x) => {
	console.error("E2E-3 失败:", x.message);
	process.exit(1);
});
