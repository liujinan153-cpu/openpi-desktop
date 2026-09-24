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
// 注入模拟对话：验收松绑后的消息流排版（行宽 820 / 行高 1.75 / 段距）
await ev("(function(){ document.getElementById('welcome')?.remove(); const c=document.getElementById('chat'); c.innerHTML = `<div class='msg user'><div class='msg-main'><div class='body'>帮我把设置弹窗的左导航改成分组样式，参考 Cherry Studio，注意行距和留白要松一点，不要太挤。</div></div></div><div class='msg assistant'><div class='msg-main'><div class='body md'><p>收到。我看了下现有结构：左导航已经是 settings-nav 加 11 个 button.tab，改成分组样式只需要插入分节标题，不动 e2e 依赖的 data-tab 属性，回归风险低。方案如下：</p><ul><li>分四组：偏好 / 模型服务 / 智能体 / 系统</li><li>导航 300px，激活态浅灰底 + 字重半级</li><li>行卡改发丝线分组卡，行距放宽</li></ul><p>核心样式只需两段，回归核验 p20/p21/p22 用的是属性选择器，插入组标签安全。</p></div></div></div><div class='steps-group'><button class='steps-head'><span class='sg-ic'><i data-lucide='wrench'></i></span><span class='sg-tx'>使用了 3 个工具 · 8.2s</span></button><div class='steps-body'><div class='tool done'><div class='head'><span class='name'>grep</span><span class='st ok'>✓ 0.4s</span></div></div></div></div>`; window.lucide.createIcons(); c.scrollTop = 0; return 1; })()");
await sleep(600);
await shot("qa-real-5-convo-dark.png");
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
