// UI v3.1 接入后真机视觉抽查（一次性，不入回归）：暗·空会话 / 暗·设置弹窗 / 亮·主界面
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 9377;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.dirname(fileURLToPath(import.meta.url));

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpi-qa-"));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "zhipu", defaultModel: "glm-5.3-flash" }));
const authSrc = path.join(os.homedir(), ".pi", "agent", "auth.json");
if (fs.existsSync(authSrc)) fs.copyFileSync(authSrc, path.join(agentDir, "auth.json"));

try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch {}
await sleep(1500);

const cleanEnv = { ...process.env };
delete cleanEnv.ELECTRON_RUN_AS_NODE;
cleanEnv.PI_CODING_AGENT_DIR = agentDir;
spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), [ROOT, `--remote-debugging-port=${PORT}`], { cwd: ROOT, env: cleanEnv, detached: false, stdio: "ignore" }).unref();

let target = null;
for (let i = 0; i < 45 && !target; i++) {
	await sleep(1000);
	try {
		const list = await new Promise((res, rej) => {
			http.get(`http://127.0.0.1:${PORT}/json`, (r) => { let d = ""; r.on("data", (c) => d += c); r.on("end", () => res(JSON.parse(d))); }).on("error", rej);
		});
		target = list.find((t) => t.type === "page" && (t.url || "").includes("index.html"));
	} catch {}
}
if (!target) { console.error("app window not ready"); process.exit(1); }
await sleep(3500); // 等 lucide/欢迎页渲染

const client = await CDP({ target: target.webSocketDebuggerUrl });
const { Page, Runtime } = client;
await Page.enable();
await Runtime.enable();
const shot = async (name) => {
	const { data } = await Page.captureScreenshot({ format: "png" });
	fs.writeFileSync(path.join(OUT, name), Buffer.from(data, "base64"));
	console.log("shot:", name);
};
const ev = async (expr) => (await Runtime.evaluate({ expression: expr, returnByValue: true })).result.value;

await shot("qa-real-1-welcome-dark.png");
await ev("document.getElementById('btn-settings') && document.getElementById('btn-settings').click()");
await sleep(1200);
await shot("qa-real-2-settings-fullpage-dark.png");
await ev("document.getElementById('btn-settings-back') && document.getElementById('btn-settings-back').click()");
await sleep(400);
// 下拉展开态：点开模型选择（自绘弹层，锚定代理按钮）
await ev("(function(){ const s=document.getElementById('model-select'); const b=s.previousElementSibling; if(b&&b.classList.contains('uisel-btn')) b.click(); return 1; })()");
await sleep(500);
await shot("qa-real-4-dropdown-dark.png");
await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
await sleep(300);
// 欢迎页工作区标题 + 侧栏用量 pill（演示数据）
await ev("workspaceLabel.textContent='openpi-desktop'; syncWelcomeTitle(); state.ctx={pct:63.2,used:1,win:1}; syncSideUsage();");
await ev("document.getElementById('btn-theme') && document.getElementById('btn-theme').click()");
await sleep(1000);
await shot("qa-real-3-chat-light.png");
await ev("document.getElementById('btn-theme') && document.getElementById('btn-theme').click()");

await client.close();
try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch {}
console.log("done");
