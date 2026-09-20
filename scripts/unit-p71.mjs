// P71 单测：redactForExport 脱敏 / main.log 轮转 / collectLogBundle 导出清单（不含 auth.json 与密钥）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initLogger, redactForExport, collectLogBundle } from "../src/main/app-logger.mjs";

let total = 0;
const ok = (name, fn) => {
	total++;
	try { fn(); console.log(`PASS ${name}`); }
	catch (err) { console.error(`FAIL ${name}: ${err.message}`); process.exitCode = 1; }
};

const mkdtemp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `openpi-p71-${p}-`));

/* ① 脱敏：混合 JSON 全打码、非敏感字段与普通文本不误伤，清洗后仍是合法 JSON */
ok("redactForExport 对混合 JSON 脱敏且不误伤普通文本", () => {
	const raw = JSON.stringify({
		apiKey: "sk-abc123-secret",
		api_key: "under-score-key",
		"Api-Key": "dash-case-key",
		token: "tok-1",
		access_token: "at-1",
		refresh_token: "rt-1",
		secret: "s3cret",
		secretKey: "sk-inner",
		password: "p@ss w0rd",
		model: "glm-5.3-flash",
		baseUrl: "https://api.example.com/v1",
		note: "apiKey is a field name, not a secret here",
		count: 42,
		nested: { password: "inner-pass", deep: { token: "deep-tok" } },
	});
	const out = redactForExport(raw);
	// 坑 #96：清洗结果必须逐项验证
	for (const leaked of ["sk-abc123-secret", "under-score-key", "dash-case-key", "tok-1", "at-1", "rt-1", "s3cret", "sk-inner", "p@ss w0rd", "inner-pass", "deep-tok"]) {
		assert.equal(out.includes(leaked), false, `泄漏: ${leaked}`);
	}
	for (const kept of ["glm-5.3-flash", "https://api.example.com/v1", "apiKey is a field name, not a secret here", "42"]) {
		assert.ok(out.includes(kept), `误伤: ${kept}`);
	}
	const parsed = JSON.parse(out); // 清洗后仍是合法 JSON
	assert.equal(parsed.apiKey, "***");
	assert.equal(parsed.nested.password, "***");
	assert.equal(parsed.nested.deep.token, "***");
	assert.equal(parsed.count, 42);
	// 普通文本（非 JSON 键值对形态）不受影响
	assert.equal(redactForExport("password: hunter2"), "password: hunter2");
	assert.equal(redactForExport("运行日志 token 超限"), "运行日志 token 超限");
});

/* ② 轮转：超 2MB 落 main.old.log，main.log 清空后继续追加；行格式 ISO [level] message */
ok("main.log 超 2MB 轮转为 main.old.log 并继续追加", () => {
	const dir = mkdtemp("rot");
	const lg = initLogger(dir);
	for (let i = 0; i < 300; i++) lg.log("x".repeat(8000)); // ~2.4MB，logger.log 不经 console，避免刷屏
	const mainFile = path.join(dir, "main.log");
	const oldFile = path.join(dir, "main.old.log");
	assert.equal(fs.existsSync(mainFile), true);
	assert.equal(fs.existsSync(oldFile), true);
	assert.ok(fs.statSync(oldFile).size >= 2 * 1024 * 1024, "old 应承载轮转前的 2MB+ 内容");
	assert.ok(fs.statSync(mainFile).size < 2 * 1024 * 1024, "main 应已清空续写");
	// 行格式：ISO时间 [level] message
	const line = fs.readFileSync(mainFile, "utf8").trim().split("\n").pop();
	assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[info\] /);
});

/* ③ console.error/warn 拦截进文件（原输出保留由控制台本身验证，这里只验文件侧） */
ok("console.error/warn 自动进 main.log", () => {
	const dir = mkdtemp("console");
	initLogger(dir);
	console.error("P71-SENTINEL-ERR", { code: 7 });
	console.warn("P71-SENTINEL-WARN");
	const content = fs.readFileSync(path.join(dir, "main.log"), "utf8");
	assert.match(content, /\[error\] P71-SENTINEL-ERR \{"code":7\}/);
	assert.match(content, /\[warn\] P71-SENTINEL-WARN/);
});

/* ④ collectLogBundle：清单齐全、settings.json 已脱敏、绝不含 auth.json / sessions */
ok("collectLogBundle 不含 auth.json/sessions 且 settings.json 已脱敏", () => {
	const dir = mkdtemp("agent");
	fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ zhipu: { key: "REAL-AUTH-KEY" } }));
	fs.mkdirSync(path.join(dir, "sessions"));
	fs.writeFileSync(path.join(dir, "sessions", "s1.jsonl"), "fake-session");
	fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ apiKey: "sk-live-999", model: "glm-5.3-flash" }));
	fs.mkdirSync(path.join(dir, "logs"));
	fs.writeFileSync(path.join(dir, "logs", "main.log"), "2026-01-01T00:00:00.000Z [error] boom\n");
	fs.writeFileSync(path.join(dir, "logs", "main.old.log"), "old-line\n");
	fs.writeFileSync(path.join(dir, "computer-audit.log"), "audit-op\n");
	const files = collectLogBundle({ piAgentDir: dir, appInfo: { version: "0.59.0", electron: "30.0.0", node: "20.0.0", platform: "win32" } });
	const names = files.map((f) => f.name);
	assert.deepEqual(names, ["main.log", "main.old.log", "computer-audit.log", "settings.json", "info.txt"]);
	assert.ok(!names.some((n) => n.includes("auth")), "不得包含 auth.json");
	assert.ok(!names.some((n) => n.toLowerCase().includes("session")), "不得包含 sessions");
	const all = files.map((f) => f.content).join("\n");
	assert.equal(all.includes("REAL-AUTH-KEY"), false, "auth.json 内容泄漏");
	assert.equal(all.includes("sk-live-999"), false, "settings 密钥未脱敏");
	const settings = JSON.parse(files.find((f) => f.name === "settings.json").content);
	assert.equal(settings.apiKey, "***");
	assert.equal(settings.model, "glm-5.3-flash");
	const info = files.find((f) => f.name === "info.txt").content;
	for (const frag of ["0.59.0", "win32", "导出时间"]) assert.ok(info.includes(frag), `info.txt 缺 ${frag}`);
});

/* ⑤ collectLogBundle：缺失文件自动跳过 */
ok("collectLogBundle 缺失文件自动跳过", () => {
	const dir = mkdtemp("sparse");
	fs.mkdirSync(path.join(dir, "logs"));
	fs.writeFileSync(path.join(dir, "logs", "main.log"), "hi\n");
	const names = collectLogBundle({ piAgentDir: dir }).map((f) => f.name);
	assert.deepEqual(names, ["main.log", "info.txt"]);
});

console.log(`unit-p71: ${total} assertions ${process.exitCode ? "FAIL" : "ALL GREEN"}`);
