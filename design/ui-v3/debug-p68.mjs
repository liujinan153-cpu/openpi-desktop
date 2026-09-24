// p68 ①调试采样器：陪跑 e2e-p68，每 250ms 采样消息数/滚动/stick/流式态
import CDP from "chrome-remote-interface";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const ROOT = process.cwd();
const PORT = 9373;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch {}
await sleep(1200);
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpi-dbg-"));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "zhipu", defaultModel: "glm-5.3-flash" }));
const authSrc = path.join(os.homedir(), ".pi", "agent", "auth.json");
if (fs.existsSync(authSrc)) fs.copyFileSync(authSrc, path.join(agentDir, "auth.json"));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; env.PI_CODING_AGENT_DIR = agentDir;
spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), [ROOT, "--remote-debugging-port=9390"], { cwd: ROOT, env, detached: false, stdio: "ignore" }).unref();
let t = null;
for (let i = 0; i < 40 && !t; i++) { await sleep(1000); try { const l = await new Promise((res, rej) => { http.get("http://127.0.0.1:9390/json", (r) => { let d = ""; r.on("data", (c) => d += c); r.on("end", () => res(JSON.parse(d))); }).on("error", rej); }); t = l.find((x) => x.type === "page" && String(x.url).includes("index.html")); } catch {} }
await sleep(2500);
const c = await CDP({ target: t.webSocketDebuggerUrl });
const { Runtime } = c; await Runtime.enable();
const ev = async (e) => (await Runtime.evaluate({ expression: e, returnByValue: true })).result.value;
let errs = [];
await ev("window.__errs=[];window.onerror=(m,s,l)=>window.__errs.push(m+' @'+l);");
// 复刻 p68① 前半：起会话 → 发送 → 等溢出 → 拉顶
await ev(`startSession(${JSON.stringify(process.cwd())})`);
await sleep(1500);
await ev(`(() => { sendText("P68-STREAM 慢流来一段"); return 1; })()`);
const t0 = Date.now();
while (Date.now() - t0 < 12000) {
	const o = await ev(`(function(){ const c=document.getElementById("chat"); return c.scrollHeight-c.clientHeight; })()`);
	if (o > 400) break;
	await sleep(100);
}
console.log("溢出就绪，耗时", Date.now() - t0, "ms");
await ev(`(() => { const c=document.getElementById("chat"); c.scrollTop=0; return 1; })()`);
for (let i = 0; i < 16; i++) {
	const s = await ev(`(function(){ const c=document.getElementById("chat"); return JSON.stringify({t:Math.round(c.scrollTop),gap:Math.round(c.scrollHeight-c.scrollTop-c.clientHeight),stick:state.stick,btnH:document.getElementById("scroll-down").hidden,msgs:document.querySelectorAll(".msg").length,tools:document.querySelectorAll(".tool").length,streaming:!!state.streaming,errs:window.__errs.length}); })()`);
	console.log(i, s);
	if (JSON.parse(s).errs > 0) { console.log(await ev("JSON.stringify(window.__errs)")); break; }
	await sleep(250);
}
await c.close();
try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch {}
process.exit(0);
