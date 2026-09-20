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

console.log(total ? `\n${total} 组断言执行完毕` : "");
