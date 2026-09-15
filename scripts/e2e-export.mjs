import CDP from "chrome-remote-interface";
import fs from "node:fs";

const client = await CDP({ target: (await CDP.List({ port: 9333 })).find((t) => t.type === "page").webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = (expr) =>
	client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => {
		if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? "").slice(0, 300));
		return r.result.value;
	});
for (let i = 0; i < 25; i++) { await new Promise((r) => setTimeout(r, 1500)); if (await ev("state.session !== null")) break; }
await ev(`document.getElementById('input').value = '只回复两个字：收到'`);
await ev("document.getElementById('btn-send').click()");
await new Promise((r) => setTimeout(r, 30000));
const p = await ev("window.openpi.exportHtml()");
console.log("PATH:", p);
const st = fs.existsSync(p);
console.log("文件存在:", st, st ? fs.statSync(p).size + " bytes" : "");
if (st) {
	const head = fs.readFileSync(p, "utf8").slice(0, 200);
	console.log("头部:", head.replace(/\n/g, " ").slice(0, 150));
}
client.close();
process.exit(0);
