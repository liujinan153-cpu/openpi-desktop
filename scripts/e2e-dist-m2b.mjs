import CDP from "chrome-remote-interface";
import fs from "node:fs";

const client = await CDP({ target: (await CDP.List({ port: 9334 })).find((t) => t.type === "page").webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = (expr) =>
	client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => {
		if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description ?? "").slice(0, 300));
		return r.result.value;
	});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("btn-tree 存在:", await ev(`!!document.getElementById('btn-tree')`));
console.log("M2按钮齐:", await ev(`['btn-compact','btn-tree','btn-export','btn-rename'].every(id=>!!document.getElementById(id))`));
const hasTree = await ev(`!!document.getElementById('btn-tree')`);
if (hasTree) {
	await ev("document.getElementById('btn-tree').click()");
	await sleep(1000);
	console.log("树节点:", await ev("document.querySelectorAll('.tree-node').length"));
}
console.log("上下文条:", await ev(`document.getElementById('ctx-bar')?.title ?? '(无)'`));
const { data } = await client.Page.captureScreenshot({ format: "png" });
fs.writeFileSync("E:/pi2/openpi-desktop/m2-dist-proof.png", Buffer.from(data, "base64"));
console.log("截图: m2-dist-proof.png");
client.close();
process.exit(0);
