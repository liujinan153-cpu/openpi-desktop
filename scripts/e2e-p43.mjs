// E2E P43：Agent 独立进程（utilityProcess）
//   ① 回合真链路经 RPC（echo 回合正常 + 事件流正常）
//   ② info().hostPid 存在（worker 进程内跑）
//   ③ workspace 跨进程同步（proxy 缓存 = worker 真实值）
//   ④ toolNames / mcp:status 经 RPC
//   ⑤ 崩溃恢复：kill worker → 自动重启 + 渲染层提示 + 新 pid
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9342;
const ECHO = 9996;
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
		res.write('data: {"id":"e","choices":[{"delta":{"content":"RPC 链路正常。"},"index":0,"finish_reason":"stop"}]}\n\n');
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
echo.listen(ECHO, "127.0.0.1");

const agentDir = path.join(os.tmpdir(), "p43-agent");
fs.rmSync(agentDir, { recursive: true, force: true });
fs.mkdirSync(agentDir, { recursive: true });
const userModels = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "models.json"), "utf8"));
userModels.providers.zhipu.baseUrl = `http://127.0.0.1:${ECHO}/v1`;
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(userModels));
const authSrc = path.join(os.homedir(), ".pi", "agent", "auth.json");
if (fs.existsSync(authSrc)) fs.copyFileSync(authSrc, path.join(agentDir, "auth.json"));

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
const EXE = process.env.OPENPI_EXE || path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const spawnArgs = process.env.OPENPI_EXE ? [`--remote-debugging-port=${PORT}`] : [ROOT, `--remote-debugging-port=${PORT}`];
spawn(EXE, spawnArgs, { cwd: ROOT, env: cleanEnv, detached: true, stdio: "ignore" }).unref();
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

/* 会话启动 + 回合（全链路经 RPC） */
const ws = path.join(os.homedir(), "p43-e2e");
fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(ws, { recursive: true });
await ev(`startSession(${JSON.stringify(ws.replace(/\\/g, "/"))}).then(() => null)`);
await sleep(1500);
const info1 = await ev(`window.openpi.agentInfo()`);
ok("② info 经 RPC 返回 hostPid", Number.isInteger(info1?.hostPid) && info1.hostPid > 0, `pid=${info1?.hostPid}`);
ok("③ workspace 跨进程同步", info1?.workspace && path.resolve(info1.workspace) === path.resolve(ws), info1?.workspace);

await ev(`window.openpi.prompt("你好").then(() => "ok").catch((e) => "ERR:" + e.message)`);
let settled = false;
for (let i = 0; i < 30; i++) {
	await sleep(1000);
	settled = await ev(`!state.streaming`);
	if (settled) break;
}
const chatText = await ev(`document.getElementById("chat").textContent`);
ok("① 回合经 RPC 完成 + 事件流正常", settled && chatText.includes("RPC 链路正常"));

/* ④ toolNames / mcp:status */
const tools = await ev(`window.openpi.agentTools()`);
ok("④ toolNames 经 RPC", Array.isArray(tools) && tools.includes("bash"), `${tools?.length ?? 0} 个工具`);
const mcp = await ev(`window.openpi.mcpStatus()`);
ok("④ mcp:status 经 RPC", mcp && typeof mcp.ready === "boolean", JSON.stringify(mcp));

/* ⑤ 崩溃恢复：杀 worker → 自动重启 → 新 pid + 渲染层提示 */
const oldPid = info1.hostPid;
try { execFileSync("taskkill", ["/PID", String(oldPid), "/F"], { stdio: "ignore" }); } catch { /* 已退出 */ }
await sleep(2500);
const info2 = await ev(`window.openpi.agentInfo()`);
ok("⑤ kill 后自动重启（新 pid）", Number.isInteger(info2?.hostPid) && info2.hostPid > 0 && info2.hostPid !== oldPid, `${oldPid} → ${info2?.hostPid}`);
const sysText = await ev(`document.getElementById("chat").textContent`);
ok("⑤ 渲染层收到恢复提示", sysText.includes("Agent 进程已重启") || sysText.includes("恢复"));
/* 恢复后 RPC 仍可用 */
const tools2 = await ev(`window.openpi.agentTools()`);
ok("⑤ 重启后 RPC 可用", Array.isArray(tools2));

echo.close();
const shotR = await client.Page.captureScreenshot({ format: "png", fromSurface: true }).catch(() => null);
if (shotR) fs.writeFileSync("e2e/p43.png", Buffer.from(shotR.data, "base64"));
try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 无进程 */ }
fs.rmSync(ws, { recursive: true, force: true });
fs.rmSync(agentDir, { recursive: true, force: true });
console.log("📸 e2e/p43.png");
console.log(fails ? `\n${total - fails}/${total} 通过` : `\n全部通过 ✓ ${total}/${total}`);
process.exit(fails ? 1 : 0);
