/** E2E-2: 验证 edit 工具的 Diff 视图（与 e2e.mjs 相同连接模式） */
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

	await ev(client, "document.getElementById('btn-new').click()");
	await new Promise((r) => setTimeout(r, 3000));

	const prompt = "请把 hello.md 文件里的标题「# Hello OpenPi」修改为「# Hello OpenPi Desktop」，并在文件末尾追加一行「- 已由 OpenPi Desktop 编辑」。只做这两处修改，用 edit 工具完成。";
	await ev(client, `document.getElementById('input').value = ${JSON.stringify(prompt)}`);
	await ev(client, "document.getElementById('btn-send').click()");

	const deadline = Date.now() + 150000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 2000));
		if (!(await ev(client, "state.streaming")) && (await ev(client, "document.querySelectorAll('.msg').length")) > 0) break;
	}

	console.log(
		JSON.stringify(
			{
				Diff卡: await ev(client, "document.querySelectorAll('.diff').length"),
				Diff行数: await ev(client, "document.querySelectorAll('.diff .dl').length"),
				加号行: await ev(client, "document.querySelectorAll('.diff .add').length"),
				减号行: await ev(client, "document.querySelectorAll('.diff .del').length"),
				工具卡: await ev(client, "document.querySelectorAll('.tool').length"),
				状态: await ev(client, "document.getElementById('status-left').textContent"),
			},
			null,
			1,
		),
	);
	const { data } = await client.Page.captureScreenshot({ format: "png" });
	fs.writeFileSync("E:/pi2/openpi-desktop/m1-diff-proof.png", Buffer.from(data, "base64"));
	console.log("截图: m1-diff-proof.png");
	client.close();
	process.exit(0);
};

main().catch((x) => {
	console.error("E2E 失败:", x.message);
	process.exit(1);
});
