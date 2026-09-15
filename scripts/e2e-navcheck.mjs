import CDP from "chrome-remote-interface";
import fs from "node:fs";
const client = await CDP({ target: (await CDP.List({ port: 9333 })).find((t) => t.type === "page").webSocketDebuggerUrl });
await client.Runtime.enable();
const r = await client.Runtime.evaluate({
	expression: `JSON.stringify({input: document.getElementById('input').value.slice(0,60), msgs: document.querySelectorAll('.msg').length, sys: [...document.querySelectorAll('.sysline')].map(x=>x.textContent).slice(-3)})`,
	returnByValue: true,
});
console.log(r.result.value);
const { data } = await client.Page.captureScreenshot({ format: "png" });
fs.writeFileSync("E:/pi2/openpi-desktop/m3-proof.png", Buffer.from(data, "base64"));
console.log("saved m3-proof.png");
client.close();
process.exit(0);
