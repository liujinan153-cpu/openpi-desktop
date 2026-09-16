// E2E P64b：⑧ 会话导入（Claude Code → OpenPi 只读回看）
//   ① 探测：btn-import 点击后检测到伪造的 ~/.claude/projects 会话
//   ② 导入：miniConfirm 确认后 sysline 显示 📥 统计
//   ③ 可见：会话列表出现 --imported 组条目；点击可打开（回看）
//   ④ 幂等：再次导入 skipped，不重复
// 隔离：e2e 全程 USERPROFILE/HOME 指向临时目录，导入落盘不污染真实 ~/.pi
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9365;
const LLM = 9505;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0, fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

/* ---- 临时 HOME + 伪造 Claude Code 会话 ---- */
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "p64b-home-"));
const ccProj = path.join(tmpHome, ".claude", "projects", "C--Users-t-demo");
fs.mkdirSync(ccProj, { recursive: true });
fs.writeFileSync(path.join(ccProj, "demo-sess-1.jsonl"), [
	JSON.stringify({ type: "user", message: { content: "帮我把配置文件改成生产环境" }, timestamp: "2026-09-16T01:00:00Z" }),
	JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "已修改 config.yaml：env 改为 production。" }, { type: "tool_use", name: "Edit", input: {} }] }, timestamp: "2026-09-16T01:00:05Z" }),
	JSON.stringify({ type: "user", isMeta: true, message: { content: "<command-name>/clear</command-name>" } }),
	"broken-line-not-json",
].join("\n") + "\n");

/* ---- mock LLM（导入流程不需要 LLM，但应用启动要模型可用——静默 finish） ---- */
const llm = http.createServer((req, res) => {
	req.on("data", () => {});
	req.on("end", () => {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }, { delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
llm.listen(LLM, "127.0.0.1");

/* ---- 沙箱 agentDir（模型指向 mock） ---- */
const agentDir = path.join(tmpHome, "agentdir");
fs.mkdirSync(path.join(agentDir, "agent"), { recursive: true });
const authSrc = path.join(os.homedir(), ".pi", "agent", "auth.json");
fs.writeFileSync(path.join(agentDir, "auth.json"), fs.existsSync(authSrc) ? fs.readFileSync(authSrc, "utf8") : "{}");
const userModels = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "models.json"), "utf8"));
userModels.providers.zhipu.baseUrl = `http://127.0.0.1:${LLM}/v1`;
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(userModels));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "zhipu", defaultModel: "glm-5.2" }));

const killPort = () => {
	try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 无进程 */ }
	let wait = 0;
	while (wait < 10000) {
		try {
			const left = execFileSync("tasklist", ["/FI", "IMAGENAME eq electron.exe"], { encoding: "utf8" });
			if (!left.includes("electron.exe")) break;
		} catch { break; }
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
		wait += 500;
	}
};
killPort();
await sleep(800);
const { ELECTRON_RUN_AS_NODE, ...cleanEnv } = process.env;
cleanEnv.PI_CODING_AGENT_DIR = agentDir;
cleanEnv.PI_HOME = tmpHome; // session-import 的 ~/.claude 源 → 临时目录（USERPROFILE 覆写会让 Electron 静默死）
cleanEnv.OPENPI_SESSIONS_ROOT = path.join(tmpHome, ".pi", "agent", "sessions"); // listSessions 同根，导入条目立即可见
spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), [ROOT, `--remote-debugging-port=${PORT}`], { cwd: ROOT, env: cleanEnv, detached: false, stdio: "inherit" }).unref();
let ready = false;
for (let i = 0; i < 45; i++) {
	await sleep(2000);
	try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ready = true; break; } } catch { /* 未就绪 */ }
}
await sleep(5000);
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
await sleep(2000);

/* ① 点击导入按钮 → 探测到伪造来源 → miniConfirm 弹出 */
await ev(`document.getElementById("btn-import").click(); 1`);
await sleep(1200);
const confirmShown = await ev(`!document.getElementById("mini-mask").hidden && document.getElementById("mini-title").textContent`);
ok("① 点击导入按钮弹出确认（探测到 claude-code）", String(confirmShown).includes("导入外部会话"), String(confirmShown));

/* ② 确认 → 导入执行 → sysline 统计 */
await ev(`document.getElementById("mini-ok").click(); 1`);
await sleep(2500);
const sysText = await ev(`Array.from(document.querySelectorAll(".sysline")).map(e => e.textContent).join(" | ")`);
ok("② 导入完成 sysline 统计", sysText.includes("📥") && sysText.includes("claude-code"), sysText.slice(-160));

/* ③ 会话列表出现 --imported 条目 */
const listText = await ev(`document.getElementById("session-list").textContent`);
ok("③ 会话列表出现导入条目", listText.includes("C--Users-t-demo") || listText.includes("--imported"), listText.slice(0, 80));

/* ③b 点击打开回看（气泡里出现导入的对话文本） */
await ev(`(() => { const items = Array.from(document.querySelectorAll("#session-list *")); const t = items.find(e => e.children.length === 0 && e.textContent.trim() && e.textContent.includes("帮我把配置文件改成生产环境")); if (t) { t.dispatchEvent(new MouseEvent("click", {bubbles: true})); return "clicked"; } return "not-found"; })()`);
await sleep(2500);
const chatText = await ev(`document.getElementById("chat").textContent`);
ok("③b 打开导入会话可见原文（回看）", chatText.includes("帮我把配置文件改成生产环境") && chatText.includes("production"), "len=" + chatText.length);

/* ④ 幂等：再导一次 skipped */
await ev(`document.getElementById("btn-import").click(); 1`);
await sleep(1000);
await ev(`document.getElementById("mini-ok").click(); 1`);
await sleep(2000);
const sysText2 = await ev(`Array.from(document.querySelectorAll(".sysline")).map(e => e.textContent).join(" | ")`);
ok("④ 二次导入幂等（新导入 0）", /新导入 0/.test(sysText2.split("|").pop() ?? "") || sysText2.includes("新导入 0"), sysText2.slice(-120));

/* 清理 */
try { client.close(); } catch { /* 忽略 */ }
try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 已退出 */ }
await sleep(1500);
llm.close();
fs.rmSync(tmpHome, { recursive: true, force: true });
console.log(fails === 0 ? `✅ e2e-p64b ${total} 过 0 败` : `❌ e2e-p64b ${total - fails} 过 ${fails} 败`);
process.exit(fails === 0 ? 0 : 1);
