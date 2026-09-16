// E2E P64：并行 worker + 多角色（⑥⑦）
//   ① subagent spawn 并行派发（tester + explore 两角色同时跑，各自独立上下文）
//   ② tester 角色有 bash（写文件落盘铁证）；explore 角色只读（read 拿到内容进结论）
//   ③ workers(list/result) 管理：取结论、并发护栏
//   ④ 结论回主会话：worker LLM 请求与主会话并发打到同一 mock，按 prompt 内容路由
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9364;
const LLM = 9504;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0, fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

/* ---- mock LLM：按 prompt 内容路由主会话/worker 请求 ---- */
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const llm = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		let body = {};
		try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* 忽略 */ }
		const last = body.messages?.[body.messages.length - 1];
			const toolNames = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
			if (process.env.P64_DUMP && last?.role === "user" && !String(typeof last.content === "string" ? last.content : JSON.stringify(last.content)).includes("你是"))
				console.error("[p64tools] 主会话 tools:", JSON.stringify(toolNames));
		const textOf = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
		const lastText = textOf(last);
		const toolCall = (id, name, args) => {
			sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] } }] });
			sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] });
			sse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 30 } });
		};
		const finish = (text) => {
			sse(res, { choices: [{ delta: { content: text } }] });
			sse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 50 } });
		};
		// worker 路由（子代理看不到主会话，prompt 以角色前缀开头）
		if (last?.role === "user" && lastText.includes("你是 tester 子代理")) {
			toolCall("t1", "run_cmd", { command: `node -e "require('fs').writeFileSync('p64-tester.txt','P64-TESTER-OK');console.log('P64-TESTER-OK')"` });
		} else if (last?.role === "tool" && lastText.includes("P64-TESTER-OK")) {
			finish("P64 测试执行完毕：p64-tester.txt 已写入，输出 P64-TESTER-OK，全部通过。");
		} else if (last?.role === "user" && lastText.includes("你是探索型子代理")) {
			toolCall("e1", "read", { path: "p64-note.txt" });
		} else if (last?.role === "tool" && lastText.includes("P64-NOTE-CONTENT")) {
			finish("P64 调研完成：p64-note.txt 内容为 P64-NOTE-CONTENT，已确认。");
		}
		// 主会话路由
		else if (last?.role === "user" && lastText.includes("P64-FLOW-A")) {
			toolCall("m1", "subagent", { batch: [
				{ prompt: "跑一下测试并把结果写入 p64-tester.txt（用 run_cmd）", task: "tester任务", role: "tester" },
				{ prompt: "调研 p64-note.txt 的内容", task: "explore任务", role: "explore" },
			] });
		} else if (last?.role === "tool" && lastText.includes("已后台派发")) {
			globalThis.p64spawned = (globalThis.p64spawned ?? 0) + 1;
			// 两个子任务都返回派发确认后，让主会话先结束回合（followUp 会在回合后唤醒）
			if (globalThis.p64spawned >= 2) finish("P64 派发完毕，两个子任务后台运行中，我先结束本轮等待结论推送。END64-DISPATCH");
			else finish("收到，继续派发。");
		} else if (last?.role === "user" && (lastText.includes("[子任务完成]") || lastText.includes("[子任务失败]"))) {
			// followUp 注入的 worker 结论（user 消息）
			globalThis.p64fu = (globalThis.p64fu ?? "") + "\n" + lastText;
			if ((globalThis.p64fu.includes("P64-TESTER-OK") && globalThis.p64fu.includes("P64-NOTE-CONTENT")) || globalThis.p64fu.split("[子任务").length >= 4) {
				globalThis.p64done = true; finish(`P64 并行完毕：tester=${globalThis.p64fu.includes("P64-TESTER-OK") ? 1 : 0} explore=${globalThis.p64fu.includes("P64-NOTE-CONTENT") ? 1 : 0} role标注=${(globalThis.p64fu.includes("role=tester") && globalThis.p64fu.includes("role=explore")) ? 1 : 0}。汇总完成。END64`);
			} else {
				finish("收到部分结论，继续等待其余子任务。");
			}
		} else {
			finish("收到。");
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
llm.listen(LLM, "127.0.0.1");

/* ---- 前置 ---- */
const ws = path.join(os.homedir(), "openpi-workspace");
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "openpi-ws", version: "1.0.0" }, null, 2));
fs.writeFileSync(path.join(ws, "p64-note.txt"), "P64-NOTE-CONTENT\n");
fs.rmSync(path.join(ws, "p64-tester.txt"), { force: true });
fs.rmSync(path.join(ws, ".openpi", "hooks.json"), { force: true });
console.log("[前置] workspace 就绪");

/* ---- 沙箱 agentDir ---- */
const agentDir = path.join(os.tmpdir(), "p64-agent");
fs.rmSync(agentDir, { recursive: true, force: true });
fs.mkdirSync(agentDir, { recursive: true });
const userModels = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "models.json"), "utf8"));
userModels.providers.zhipu.baseUrl = `http://127.0.0.1:${LLM}/v1`;
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(userModels));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "zhipu", defaultModel: "glm-5.2" }));
const authSrc = path.join(os.homedir(), ".pi", "agent", "auth.json");
if (fs.existsSync(authSrc)) fs.copyFileSync(authSrc, path.join(agentDir, "auth.json"));

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
	const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
	const pids = new Set(
		out.split("\n").filter((l) => l.includes(`:${PORT}`) && l.includes("LISTENING"))
			.map((l) => l.trim().split(/\s+/).at(-1)).filter((p) => /^\d+$/.test(p)),
	);
	for (const pid of pids) execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
};
killPort();
await sleep(800);
const { ELECTRON_RUN_AS_NODE, ...cleanEnv } = process.env;
cleanEnv.PI_CODING_AGENT_DIR = agentDir;
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

/* ⓪ 切到 git 工作区会话 */
await ev(`startSession(${JSON.stringify(ws)})`);
await sleep(1500);
ok("⓪ 切到工作区会话", true);

/* ① 全链路：mock 端变量断言（渲染层气泡是流式的，文本截取时机不稳定——P63 坑） */
globalThis.p64got = null;
globalThis.p64fu = null;
await ev(`(() => { sendText("P64-FLOW-A 用 batch 并行派发 tester 和 explore 两个子任务"); return 1; })()`);
for (let i = 0; i < 480 && !globalThis.p64done; i++) await sleep(500);
await sleep(1500);
const t1 = globalThis.p64fu ?? "[TIMEOUT] 结论未推送（p64done=" + globalThis.p64done + "）";
ok("① tester worker 结论聚合（含 bash 输出）", t1.includes("P64-TESTER-OK"), t1.slice(0, 100));
ok("② explore worker 结论聚合（read 到内容）", t1.includes("P64-NOTE-CONTENT"), t1.slice(0, 100));
ok("③ 结论带角色标注", t1.includes("role=tester") && t1.includes("role=explore"), "");

/* ⑤ 磁盘铁证：tester 的 bash 写文件生效（角色白名单 + auto-edit 档直通） */
const testerOut = fs.existsSync(path.join(ws, "p64-tester.txt")) ? fs.readFileSync(path.join(ws, "p64-tester.txt"), "utf8") : "";
ok("⑤ tester bash 写文件落盘", testerOut.includes("P64-TESTER-OK"), JSON.stringify(testerOut.slice(0, 60)));

/* 清理 */
try { client.close(); } catch { /* 忽略 */ }
try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 已退出 */ }
await sleep(1500);
llm.close();
console.log(fails === 0 ? `✅ e2e-p64 ${total} 过 0 败` : `❌ e2e-p64 ${total - fails} 过 ${fails} 败`);
process.exit(fails === 0 ? 0 : 1);
