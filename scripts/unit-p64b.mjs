/** P64⑧ 会话导入单测：临时 HOME 里造假 Claude Code 会话 → 解析/导入/幂等/列表可见 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const node = process.execPath;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "p64b-home-"));
// 造假 Claude Code 会话
const proj = path.join(tmpHome, ".claude", "projects", "C--Users-t-demo");
fs.mkdirSync(proj, { recursive: true });
const lines = [
	JSON.stringify({ type: "user", message: { content: "帮我写个函数" }, timestamp: "2026-09-16T01:00:00Z" }),
	JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "好的，函数如下：" }, { type: "tool_use", name: "Write", input: {} }] }, timestamp: "2026-09-16T01:00:05Z" }),
	JSON.stringify({ type: "user", isMeta: true, message: { content: "<command-name>/clear</command-name>" } }),
	JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
	"not-json-line",
];
fs.writeFileSync(path.join(proj, "abc-123.jsonl"), lines.join("\n") + "\n");

const driver = `
import { pathToFileURL } from "node:url";
import path from "node:path";
const mod = await import(pathToFileURL(${JSON.stringify(path.resolve("src/main/session-import.mjs").split(path.sep).join("/"))}));
const { detectImportSources, parseClaudeJsonl, importAllClaude } = mod;
import fs from "node:fs";
import assert from "node:assert";
const proj = ${JSON.stringify(proj)};
const src = fs.readdirSync(proj).filter(f => f.endsWith(".jsonl"))[0];
// 1) 探测
const srcs = detectImportSources();
assert.ok(srcs.some(s => s.kind === "claude-code" && s.count >= 1), "探测到 claude-code 来源");
// 2) 解析：只取文本对话，meta/工具/坏行过滤
const msgs = parseClaudeJsonl(path.join(proj, src));
assert.strictEqual(msgs.length, 2, "解析出 2 条文本消息，实际 " + msgs.length);
assert.strictEqual(msgs[0].role, "user");
assert.strictEqual(msgs[1].role, "assistant");
assert.ok(!msgs[1].text.includes("tool_use"), "tool_use 已滤");
// 3) 导入 + 幂等
const r1 = importAllClaude();
assert.strictEqual(r1.imported, 1, "首次导入 1，实际 " + JSON.stringify(r1));
const r2 = importAllClaude();
assert.strictEqual(r2.imported, 0, "二次导入幂等跳过");
assert.strictEqual(r2.skipped, 1);
// 4) 落盘格式：首行 session + message 行，listSessions 可扫
const home = process.env.USERPROFILE;
const root = path.join(home, ".pi", "agent", "sessions");
let found = [];
for (const g of fs.readdirSync(root)) {
	const gd = path.join(root, g);
	if (!fs.statSync(gd).isDirectory()) continue;
	for (const f of fs.readdirSync(gd)) {
		if (!f.endsWith(".jsonl")) continue;
		const first = JSON.parse(fs.readFileSync(path.join(gd, f), "utf8").split("\\n")[0]);
		if (first.type === "session" && first.openpiImported?.from === "claude-code") found.push(path.join(gd, f));
	}
}
assert.strictEqual(found.length, 1, "导入会话落盘，实际 " + found.length);
const body = fs.readFileSync(found[0], "utf8").split("\\n").filter(Boolean);
assert.strictEqual(body.length, 3, "session 头 + 2 条消息");
assert.strictEqual(JSON.parse(body[1]).message.role, "user");
console.log("UNIT-P64B-ALL-PASS");
`;
fs.writeFileSync(path.join(tmpHome, "driver.mjs"), driver);
const r = spawnSync(node, [path.join(tmpHome, "driver.mjs")], { encoding: "utf8", env: { ...process.env, USERPROFILE: tmpHome, HOME: tmpHome }, timeout: 60000 });
console.log(r.stdout);
if (r.status !== 0) {
	console.error(r.stderr);
	process.exit(1);
}
fs.rmSync(tmpHome, { recursive: true, force: true });
console.log("清理完成");
