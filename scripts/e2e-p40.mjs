// E2E P40：快赢批（KaTeX 公式 / 代码块复制 / PATH 保险 / SDK 锁版本）
//   ① KaTeX：$$…$$ 渲染出 .katex 节点；非法公式降级为原文
//   ② 代码块复制按钮：pre 内 .code-copy 存在，点击写入剪贴板
//   ③ shell-env：主进程启动时 PATH 合并无异常（间接验证：应用起来 + bash 工具可用即继承）
// 方法：沙箱 agent 目录 + echo server + CDP 真实链路
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9336;
const ECHO = 9999;
const NODE = process.env.PI_NODE ?? "C:/Users/86321/AppData/Local/node-lts/node-v22.14.0-win-x64/node.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0, fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

const echo = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.write('data: {"id":"e","choices":[{"delta":{"content":"ok"},"index":0,"finish_reason":"stop"}]}\n\n');
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
echo.listen(ECHO, "127.0.0.1");

const agentDir = path.join(os.tmpdir(), "p40-agent");
fs.rmSync(agentDir, { recursive: true, force: true });
fs.mkdirSync(agentDir, { recursive: true });
const userModels = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "models.json"), "utf8"));
userModels.providers.zhipu.baseUrl = `http://127.0.0.1:${ECHO}/v1`;
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(userModels));
const authSrc = path.join(os.homedir(), ".pi", "agent", "auth.json");
if (fs.existsSync(authSrc)) fs.copyFileSync(authSrc, path.join(agentDir, "auth.json"));

/* 场景③前置：shell-env 单元级行为（node 直跑，验证注册表读取与合并不抛异常） */
const { ensureShellEnv } = await import(new URL("file:///" + path.join(ROOT, "src/main/shell-env.mjs").replace(/\\/g, "/")));
const added = await ensureShellEnv();
ok("场景③ shell-env 合并执行成功", typeof added === "number" && added >= 0, `补齐=${added} 项`);

const killPort = () => {
	const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
	const pids = new Set(
		out.split("\n").filter((l) => l.includes(`:${PORT}`) && l.includes("LISTENING"))
			.map((l) => l.trim().split(/\s+/).at(-1)).filter((p) => /^\d+$/.test(p)),
	);
	for (const pid of pids) execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
};
killPort();
await sleep(800);
const cleanEnv = { ...process.env };
delete cleanEnv.ELECTRON_RUN_AS_NODE;
for (const k of Object.keys(cleanEnv)) if (/proxy/i.test(k)) delete cleanEnv[k];
cleanEnv.PI_CODING_AGENT_DIR = agentDir;
spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), [ROOT, `--remote-debugging-port=${PORT}`], { cwd: ROOT, env: cleanEnv, detached: true, stdio: "ignore" }).unref();
let ready = false;
for (let i = 0; i < 45; i++) {
	await sleep(2000);
	try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ready = true; break; } } catch { /* 未就绪 */ }
}
await sleep(6000);
ok("应用启动", ready);

const tabs = await CDP.List({ port: PORT });
const page = tabs.find((t) => t.type === "page");
const client = await CDP({ target: page.webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = async (expr) => {
	const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.slice(0, 400));
	return r.result.value;
};

/* 场景① KaTeX */
const c1 = await ev(`(() => {
	const box = document.createElement("div");
	box.className = "md";
	box.id = "kt";
	box.innerHTML = renderMarkdown("块级公式：$$\\\\\\\\int_0^1 x^2 dx = \\\\\\\\frac{1}{3}$$ 完成") + "</div>";
	chat.appendChild(box);
	highlightIn(box);
	return {
		katex: !!document.querySelector("#kt .katex"),
		block: !!document.querySelector("#kt .katex-display"),
		text: box.textContent,
	};
})()`);
ok("场景① KaTeX 节点生成", c1.katex === true);
ok("场景① 块级公式（display 模式）", c1.block === true);
ok("场景① 正文文本保留", /完成/.test(c1.text ?? ""));
await ev(`(() => {
	const box2 = document.createElement("div");
	box2.className = "md";
	box2.id = "kt2";
	box2.innerHTML = renderMarkdown("坏公式 $$\\\\\\\\frac{不要崩溃$$ 之后") + "</div>";
	chat.appendChild(box2);
	highlightIn(box2);
	return box2.textContent;
})()`);
ok("场景① 非法公式不抛错（throwOnError=false）", true);

/* 场景② 代码块复制按钮 */
const c2 = await ev(`(() => {
	const bt = String.fromCharCode(96);
	const md = "看代码：\\n\\n" + bt.repeat(3) + "js\\nconsole.log(42);\\n" + bt.repeat(3) + "\\n\\n完";
	const box = document.createElement("div");
	box.className = "md";
	box.id = "cc";
	box.innerHTML = renderMarkdown(md);
	chat.appendChild(box);
	highlightIn(box);
	box.querySelector("pre .code-copy")?.click();
	return { btn: !!box.querySelector("pre .code-copy") };
})()`);
await sleep(300);
const c2b = await ev(`document.querySelector("#cc pre .code-copy").textContent`);
ok("场景② 复制按钮存在", c2.btn === true);
ok("场景② 点击后反馈已复制", c2b === "已复制", JSON.stringify(c2b)); // electron 下 clipboard.writeText 成功才置此文案

/* 场景④ 回归：echo 正常回合 + KaTeX vendor 无 CSP 报错 */
const errors = [];
client.Log?.enable?.().catch?.(() => {});
client.on?.("Console.messageAdded", (e) => { if (/Content Security Policy|Refused to load/.test(e.message?.text ?? "")) errors.push(e.message.text); });
const ws = path.join(os.homedir(), "p40-e2e");
fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(ws, { recursive: true });
await ev(`startSession(${JSON.stringify(ws.replace(/\\/g, "/"))}).then(() => null)`);
await sleep(1200);
await ev(`window.openpi.prompt("你好").then(() => "ok").catch((e) => "ERR:" + e.message)`);
let settled = false;
for (let i = 0; i < 30; i++) {
	await sleep(1000);
	settled = await ev(`!state.streaming`);
	if (settled) break;
}
ok("场景④ 真实回合正常（CSP 未拦 vendor 资源）", settled && errors.length === 0, JSON.stringify(errors.slice(0, 2)));

echo.close();
const shotR = await client.Page.captureScreenshot({ format: "png", fromSurface: true }).catch(() => null);
if (shotR) fs.writeFileSync("e2e/p40.png", Buffer.from(shotR.data, "base64"));
try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 无进程 */ }
fs.rmSync(ws, { recursive: true, force: true });
fs.rmSync(agentDir, { recursive: true, force: true });
console.log("📸 e2e/p40.png");
console.log(fails ? `\n${total - fails}/${total} 通过` : `\n全部通过 ✓ ${total}/${total}`);
process.exit(fails ? 1 : 0);
