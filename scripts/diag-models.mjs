import CDP from "chrome-remote-interface";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = await CDP({ target: (await CDP.List({ port: 9333 })).find((t) => t.type === "page").webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = (x) => client.Runtime.evaluate({ expression: x, returnByValue: true, userGesture: true, awaitPromise: true }).then((r) => { if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? "").slice(0, 300)); return r.result.value; });
for (let i = 0; i < 30; i++) { await sleep(1500); if (await ev("state.models.length > 0")) break; }
console.log("可用模型：");
const models = await ev("state.models.map(function(m){ return m.provider + '/' + m.id + ' ' + JSON.stringify(m.inputModes || m.input || ''); }).join(String.fromCharCode(10))");
console.log(models);
client.close(); process.exit(0);
