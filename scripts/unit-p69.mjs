// 单测 P69：Codex/OpenCode 解析 + 导入落盘（进程外跑，env 隔离，不碰真实 ~/.pi）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let total = 0, fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p69-unit-"));
const tmpHome = path.join(tmp, "home");
fs.mkdirSync(tmpHome, { recursive: true });
const sessRoot = path.join(tmp, "sessions-root");

// fixture：Codex rollout（含 developer / XML 注入 / 真 user+assistant）
const codexDir = path.join(tmpHome, ".codex", "sessions", "2026", "06", "06");
fs.mkdirSync(codexDir, { recursive: true });
const roll = [
	JSON.stringify({ timestamp: "2026-06-06T15:30:36.956Z", type: "session_meta", payload: { session_id: "abc", cwd: "C:\\proj", originator: "Codex Desktop" } }),
	JSON.stringify({ timestamp: "2026-06-06T15:30:51.635Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>keep out</permissions instructions>" }] } }),
	JSON.stringify({ timestamp: "2026-06-06T15:30:52.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>C:\\proj</cwd>\n</environment_context>" }] } }),
	JSON.stringify({ timestamp: "2026-06-06T15:31:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "你好，帮我写个函数" }] } }),
	JSON.stringify({ timestamp: "2026-06-06T15:32:37.464Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "好的，函数如下：\n\n```js\nconst f = () => 1;\n```" }] } }),
	JSON.stringify({ timestamp: "2026-06-06T15:32:40.000Z", type: "event_msg", payload: { type: "task_complete" } }),
	"{{broken json line",
].join("\n");
fs.writeFileSync(path.join(codexDir, "rollout-2026-06-06T23-30-36-abc.jsonl"), roll);

// fixture：OpenCode（布局 B：session/*.json + message/<sid>/<msg>/info.json + part/<sid>/<msg>/*.json）
const st = path.join(tmpHome, ".local", "share", "opencode", "storage");
fs.mkdirSync(path.join(st, "session", "projX"), { recursive: true });
fs.writeFileSync(path.join(st, "session", "projX", "ses_1.json"), JSON.stringify({ id: "ses_1", directory: "/tmp/projX", title: "修 bug", time: { created: 1000, updated: 3000 } }));
fs.mkdirSync(path.join(st, "message", "ses_1", "msg_1"), { recursive: true });
fs.writeFileSync(path.join(st, "message", "ses_1", "msg_1", "info.json"), JSON.stringify({ id: "msg_1", role: "user" }));
fs.mkdirSync(path.join(st, "part", "ses_1", "msg_1"), { recursive: true });
fs.writeFileSync(path.join(st, "part", "ses_1", "msg_1", "part_1.json"), JSON.stringify({ type: "text", text: "这个报错怎么修" }));
fs.mkdirSync(path.join(st, "message", "ses_1", "msg_2"), { recursive: true });
fs.writeFileSync(path.join(st, "message", "ses_1", "msg_2", "info.json"), JSON.stringify({ id: "msg_2", role: "assistant" }));
fs.mkdirSync(path.join(st, "part", "ses_1", "msg_2"), { recursive: true });
fs.writeFileSync(path.join(st, "part", "ses_1", "msg_2", "part_1.json"), JSON.stringify({ type: "text", text: "是空指针，改成可选链即可" }));

process.env.PI_HOME = tmpHome;
process.env.OPENPI_SESSIONS_ROOT = sessRoot;
const si = await import(new URL("../src/main/session-import.mjs", import.meta.url).href);

/* ① detect */
const src = si.detectImportSources();
ok("① 探测到 codex + opencode", src.some((s) => s.kind === "codex" && s.count === 1) && src.some((s) => s.kind === "opencode" && s.count === 1), JSON.stringify(src));

/* ② Codex 解析：developer/XML 跳过，user+assistant 保留 */
const codexFile = path.join(codexDir, "rollout-2026-06-06T23-30-36-abc.jsonl");
const msgs = si.parseCodexJsonl(codexFile);
ok("② Codex 解析：2 条（滤 developer+XML）", msgs.length === 2 && msgs[0].role === "user" && msgs[0].text.includes("写个函数") && msgs[1].role === "assistant" && msgs[1].text.includes("函数如下"), JSON.stringify(msgs.map((m) => [m.role, m.text.slice(0, 20)])));

/* ③ Codex 导入落盘 */
const r3 = si.importAllCodex();
const files = fs.readdirSync(path.join(sessRoot, "codex--imported"));
const body = fs.readFileSync(path.join(sessRoot, "codex--imported", files[0]), "utf8");
ok("③ importAllCodex 落盘 pi 格式", r3.imported === 1 && files.length === 1 && body.includes(`"from":"codex"`) && body.includes("写个函数"), JSON.stringify(r3));
const r3b = si.importAllCodex();
ok("③b 幂等：二次导入 skipped", r3b.imported === 0 && r3b.skipped === 1, JSON.stringify(r3b));

/* ④ OpenCode 导入落盘 */
const r4 = si.importAllOpenCode();
const ocGrp = fs.readdirSync(sessRoot).find((d) => d.startsWith("opencode-"));
const ocBody = fs.readFileSync(path.join(sessRoot, ocGrp, fs.readdirSync(path.join(sessRoot, ocGrp))[0]), "utf8");
ok("④ OpenCode 导入（布局 B）", r4.imported === 1 && ocBody.includes("这个报错怎么修") && ocBody.includes("可选链") && ocBody.includes(`"from":"opencode"`), JSON.stringify(r4));

/* ⑤ 真实 Codex 数据解析（本机 ~/.codex 若有） */
const realDir = path.join(os.homedir(), ".codex", "sessions");
let realFiles = [];
try { realFiles = fs.readdirSync(realDir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl")); } catch { /* 无 */ }
if (realFiles.length) {
	const rf = path.join(realDir, realFiles[0]);
	const rm = si.parseCodexJsonl(rf);
	ok("⑤ 真实 Codex 样本可解析", rm.length >= 1 && rm.some((m) => m.role === "assistant"), `文件=${realFiles[0].slice(-30)} msgs=${rm.length}`);
} else {
	console.log("SKIP ⑤（本机无 ~/.codex 数据）");
}

console.log(`\nunit-p69: ${total - fails}/${total} ${fails ? "FAIL" : "ALL GREEN"}`);
process.exit(fails ? 1 : 0);
