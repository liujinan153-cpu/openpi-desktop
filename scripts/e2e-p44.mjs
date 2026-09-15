// E2E P44：SQLite FTS5 会话索引（引擎在 electron main 进程，node ABI 不兼容故全在应用内测）
//   ① 启动同步：夹具 3 个会话（≥3 字中文 / 2 字中文 / 标题）入索引
//   ② trigram 中文搜索（≥3 字）命中 + preview 上下文
//   ③ 短查询（2 字）LIKE 回退命中
//   ④ 增量：mtime 变更重索引（新文本可搜到）；文件删除 → prune
//   ⑤ 真链路：sessions:search IPC 返回 FTS 结果（形状兼容旧版）
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9343;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0, fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

const mkSession = (file, title, msgs) => {
	const lines = [{ type: "session", id: path.basename(file, ".jsonl"), cwd: "C:/ws", title }];
	for (const m of msgs) lines.push({ type: "message", message: { role: m[0], content: m[1] } });
	fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};

const sessRoot = path.join(os.tmpdir(), `p44-sessions-${Date.now()}`);
const grp = path.join(sessRoot, "grp1");
fs.mkdirSync(grp, { recursive: true });
mkSession(path.join(grp, "a.jsonl"), "整理报表", [["user", "请帮我整理第三季度的凤凰花开销售报表"], ["assistant", "好的，已生成报表。"]]);
mkSession(path.join(grp, "b.jsonl"), "雪莲任务", [["user", "关于雪莲的调研进度"], ["assistant", "雪莲调研已完成一半。"]]);
mkSession(path.join(grp, "c.jsonl"), "旧会话", [["user", "帮我看看预算表和报表"], ["assistant", "预算表和报表都没问题。"]]);
const dbPath = path.join(os.tmpdir(), `p44-idx-${Date.now()}.db`);

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
cleanEnv.PI_CODING_AGENT_DIR = path.join(os.tmpdir(), "p44-agent");
fs.mkdirSync(cleanEnv.PI_CODING_AGENT_DIR, { recursive: true });
cleanEnv.OPENPI_SESSIONS_ROOT = sessRoot;
cleanEnv.OPENPI_INDEX_DB = dbPath;
spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), [ROOT, `--remote-debugging-port=${PORT}`], { cwd: ROOT, env: cleanEnv, detached: true, stdio: "ignore" }).unref();
let ready = false;
for (let i = 0; i < 45; i++) {
	await sleep(2000);
	try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ready = true; break; } } catch { /* 未就绪 */ }
}
await sleep(6000);
ok("应用启动", ready);
ok("① db 文件已建（引擎可用）", fs.existsSync(dbPath), dbPath ? path.basename(dbPath) : "无");

const tabs = await CDP.List({ port: PORT });
const page = tabs.find((t) => t.type === "page");
const client = await CDP({ target: page.webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = async (expr) => {
	const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.slice(0, 400));
	return r.result.value;
};

/* 启动同步是 4s 后台任务，等它完成 */
await sleep(4500);

/* ② trigram 中文搜索 */
const r1 = await ev(`window.openpi.sessionsSearch("凤凰花开")`);
ok("② ≥3字中文命中", Array.isArray(r1) && r1.length === 1 && r1[0].file.endsWith("a.jsonl"), JSON.stringify(r1?.map((r) => path.basename(r.file))));
ok("② preview 带上下文", r1?.[0]?.preview?.includes("凤凰花开") && r1[0].preview.length > "凤凰花开".length, JSON.stringify(r1?.[0]?.preview?.slice(0, 40)));
ok("② 形状兼容（id/cwd/title）", r1?.[0]?.id === "a" && r1[0].cwd === "C:/ws" && r1[0].title === "整理报表");
const r2 = await ev(`window.openpi.sessionsSearch("报表")`);
ok("② 跨会话命中排序", Array.isArray(r2) && r2.length === 2, r2?.map((r) => path.basename(r.file)).join(","));

/* ③ 短查询 LIKE 回退 */
const r3 = await ev(`window.openpi.sessionsSearch("雪莲")`);
ok("③ 2字词命中（LIKE 回退）", Array.isArray(r3) && r3.length === 1 && r3[0].file.endsWith("b.jsonl"), JSON.stringify(r3?.map((r) => path.basename(r.file))));

/* ④ 增量 + prune：改 a.jsonl 加新文本 → 可搜新词；删 b.jsonl → 搜不到 */
await sleep(1100); // 保证 mtime 变化可测
mkSession(path.join(grp, "a.jsonl"), "整理报表", [["user", "新增关键词玉兰花值得索引"]]);
const inc = await ev(`window.openpi.sessionsSearch("玉兰花")`);
ok("④ 增量重索引（settled 钩子同路径）", Array.isArray(inc) && inc.length === 1 && inc[0].file.endsWith("a.jsonl"), JSON.stringify(inc?.map((r) => path.basename(r.file))));
fs.rmSync(path.join(grp, "b.jsonl"));
const r4 = await ev(`window.openpi.sessionsSearch("雪莲")`);
ok("④ 删除文件后搜索即清理（sync 前置 prune）", Array.isArray(r4) && r4.length === 0);

/* ⑤ 无结果与空查询 */
const r5 = await ev(`window.openpi.sessionsSearch("不存在的词汇组")`);
ok("⑤ 无结果空数组", Array.isArray(r5) && r5.length === 0);
const r6 = await ev(`window.openpi.sessionsSearch("")`);
ok("⑤ 空查询空数组", Array.isArray(r6) && r6.length === 0);

const shotR = await client.Page.captureScreenshot({ format: "png", fromSurface: true }).catch(() => null);
if (shotR) fs.writeFileSync("e2e/p44.png", Buffer.from(shotR.data, "base64"));
try { execFileSync("taskkill", ["/IM", "electron.exe", "/T", "/F"], { stdio: "ignore" }); } catch { /* 无进程 */ }
await sleep(2500); // 等 electron 退出释放 db 文件锁（WAL）
fs.rmSync(sessRoot, { recursive: true, force: true });
fs.rmSync(dbPath, { force: true });
fs.rmSync(cleanEnv.PI_CODING_AGENT_DIR, { recursive: true, force: true });
console.log("📸 e2e/p44.png");
console.log(fails ? `\n${total - fails}/${total} 通过` : `\n全部通过 ✓ ${total}/${total}`);
process.exit(fails ? 1 : 0);
