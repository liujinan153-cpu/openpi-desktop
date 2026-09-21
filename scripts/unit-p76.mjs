// P76 单测：模型接入体验纯函数 —— parseModelsBody 解析容错 / normalizeBaseUrl 规范化 / fmtLatency 延迟人话 / probeModels 入参防御。
// 纯函数抽在 config-store.mjs（IO 分离：probeModels 的网络路径不在此测，只测不发请求的入参校验分支）。
import assert from "node:assert/strict";
import { parseModelsBody, normalizeBaseUrl, fmtLatency, probeModels } from "../src/main/config-store.mjs";

let total = 0;
const ok = (name, fn) => {
	total++;
	try { fn(); console.log(`PASS ${name}`); }
	catch (err) { console.error(`FAIL ${name}: ${err.message}`); process.exitCode = 1; }
};

/* ① OpenAI 兼容 {data:[{id}]}：标准形态 + 过滤空值 + 去重 */
ok("① parseModelsBody 解析 OpenAI data[].id", () => {
	const out = parseModelsBody({ data: [{ id: "glm-5.3-flash" }, { id: "glm-5.2" }, { id: "glm-5.3-flash" }, { id: "  " }] });
	assert.deepEqual(out, ["glm-5.3-flash", "glm-5.2"]);
});

/* ② Ollama 兼容 {models:[{name}]} 与裸数组、字符串数组、model 字段 */
ok("② parseModelsBody 容错 Ollama/裸数组/字符串/model 字段", () => {
	assert.deepEqual(parseModelsBody({ models: [{ name: "qwen3:8b" }, { name: "llama3.1" }] }), ["qwen3:8b", "llama3.1"]);
	assert.deepEqual(parseModelsBody(["a", "b"]), ["a", "b"]);
	assert.deepEqual(parseModelsBody([{ model: "m1" }, { other: 1 }]), ["m1"]);
	assert.deepEqual(parseModelsBody({ data: ["x", { id: "y" }] }), ["x", "y"]);
});

/* ③ 坏输入不抛错：null / 数字 / 字符串 / 空对象 / 无数组字段 → 空数组 */
ok("③ parseModelsBody 坏 JSON/坏结构返回空数组", () => {
	for (const bad of [null, undefined, 42, "oops", {}, { data: {} }, { models: "no" }, []]) {
		assert.deepEqual(parseModelsBody(bad), [], `bad=${JSON.stringify(bad)}`);
	}
});

/* ④ normalizeBaseUrl：去尾斜杠/首尾空白，保证 {base}/models 拼接形态统一 */
ok("④ normalizeBaseUrl 去尾斜杠与空白", () => {
	assert.equal(normalizeBaseUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
	assert.equal(normalizeBaseUrl("  http://localhost:11434/v1/// "), "http://localhost:11434/v1");
	assert.equal(normalizeBaseUrl(""), "");
	assert.equal(normalizeBaseUrl(null), "");
	// 拼接形态：规范化后 + /models 不出现双斜杠
	assert.equal(normalizeBaseUrl("http://x/v1/") + "/models", "http://x/v1/models");
});

/* ⑤ fmtLatency：ms/s 两档 + 非法值兜底 */
ok("⑤ fmtLatency 延迟人话格式化", () => {
	assert.equal(fmtLatency(0), "0ms");
	assert.equal(fmtLatency(380.4), "380ms");
	assert.equal(fmtLatency(1250), "1.3s");
	assert.equal(fmtLatency(-1), "—");
	assert.equal(fmtLatency("abc"), "—");
});

/* ⑥ probeModels 入参防御：非法 baseUrl 直接报错不发网络请求（快速返回，无超时等待） */
/* ⑥ probeModels 入参防御：非法 baseUrl 直接报错不发网络请求（顶层 await 执行） */
try {
	total++;
	const t0 = Date.now();
	const r = await probeModels({ baseUrl: "ftp://nope", apiKey: "k" });
	assert.equal(r.ok, false);
	assert.match(r.error, /http\(s\)/);
	assert.deepEqual(r.models, []);
	assert.ok(Date.now() - t0 < 1000, "不应发起网络请求");
	console.log("PASS ⑥ probeModels 非法 baseUrl 快速失败");
} catch (err) {
	console.error(`FAIL ⑥ probeModels 非法 baseUrl 快速失败: ${err.message}`);
	process.exitCode = 1;
}


/* ---- P76 交付1：子智能体动作流水（src/main/p76-activity.mjs） ---- */
import { workerActivityFromEvent, basename, clip } from "../src/main/p76-activity.mjs";

ok("⑦ edit/write/apply_patch → 「编辑 <basename>」+ detail 全路径", () => {
	const a = workerActivityFromEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "edit", args: { path: "C:\\work\\src\\app.ts" } });
	assert.equal(a.kind, "tool");
	assert.equal(a.title, "编辑 app.ts");
	assert.equal(a.detail, "C:\\work\\src\\app.ts");
	const w = workerActivityFromEvent({ type: "tool_execution_start", toolCallId: "t2", toolName: "write", args: { file_path: "/home/u/new-file.ts" } });
	assert.equal(w.title, "编辑 new-file.ts"); // write 也统一「编辑」
	const ap = workerActivityFromEvent({ type: "tool_execution_start", toolCallId: "t3", toolName: "apply_patch", args: { path: "a/b.md/" } });
	assert.equal(ap.title, "编辑 b.md"); // 尾部分隔符不吃进 basename
});

ok("⑧ bash/run_cmd → 「运行 <命令前60字>」+ detail 命令（换行压平）", () => {
	const long = "npm run build && npm test && echo " + "x".repeat(200);
	const a = workerActivityFromEvent({ type: "tool_execution_start", toolCallId: "t4", toolName: "run_cmd", args: { command: long } });
	assert.equal(a.title.startsWith("运行 npm run build && npm test && echo xxxxx"), true);
	assert.ok(a.title.length <= 63, `title≤63, got ${a.title.length}`); // 「运行 」+ 60
	assert.equal(a.detail.length, 120); // detail 截 ≤120
	assert.equal(a.detail.includes("\n"), false); // 换行压平
	const b = workerActivityFromEvent({ type: "tool_execution_start", toolCallId: "t5", toolName: "bash", args: "git status" }); // args 为字符串
	assert.equal(b.title, "运行 git status");
});

ok("⑨ read → 「读取 <basename>」+ offset 有则 detail 加 L<offset>~", () => {
	const a = workerActivityFromEvent({ type: "tool_execution_start", toolCallId: "t6", toolName: "read", args: { path: "src/main/app.mjs", offset: 120 } });
	assert.equal(a.title, "读取 app.mjs");
	assert.equal(a.detail, "src/main/app.mjs L120~");
	const b = workerActivityFromEvent({ type: "tool_execution_start", toolCallId: "t7", toolName: "read", args: { path: "only-base.mjs" } });
	assert.equal(b.title, "读取 only-base.mjs");
	assert.equal(b.detail, ""); // 无 offset 不造假
});

ok("⑩ grep/find/ls 搜索类 → 「搜索 <pattern 前40字>」；未知工具兜底工具名；非工具事件 null", () => {
	const a = workerActivityFromEvent({ type: "tool_execution_start", toolCallId: "t8", toolName: "grep", args: { pattern: "worker_activity" } });
	assert.equal(a.title, "搜索 worker_activity");
	const b = workerActivityFromEvent({ type: "tool_execution_start", toolCallId: "t9", toolName: "find", args: { pattern: "p".repeat(80) } });
	assert.equal(b.title, `搜索 ${"p".repeat(40)}`);
	const c = workerActivityFromEvent({ type: "tool_execution_start", toolCallId: "t10", toolName: "webfetch", args: { url: "https://x" } });
	assert.equal(c.title, "webfetch");
	assert.equal(workerActivityFromEvent({ type: "message_end" }), null);
	assert.equal(workerActivityFromEvent(null), null);
	const e = workerActivityFromEvent({ type: "tool_execution_end", toolCallId: "t8", isError: true });
	assert.deepEqual(e, { kind: "tool_end", toolCallId: "t8", ok: false });
});

ok("⑪ basename/clip 纯函数边界", () => {
	assert.equal(basename("a\\b\\c.txt"), "c.txt");
	assert.equal(basename("/x/y/"), "y"); // 尾分隔符剥掉后取末段
	assert.equal(basename(null), "");
	assert.equal(clip("  a\n b  ", 10), "a b");
	assert.equal(clip(undefined, 5), "");
});
console.log(total ? `\n${total} 组断言执行完毕` : "");
