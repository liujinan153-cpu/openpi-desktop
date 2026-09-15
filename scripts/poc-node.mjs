/**
 * M0 验证脚本（无头模式）：验证 Pi SDK 在纯 Node 下跑通
 * 1. ModelRuntime 读取 ~/.pi/agent/{auth.json,models.json,settings.json}
 * 2. 列出目录内全部模型 + 鉴权可用模型
 * 3. 选中模型流式对话一轮，打印 token 用量（验证"省 token"可观测）
 *
 * 运行: npm run poc  （可选环境变量 POC_PROVIDER / POC_MODEL 指定模型）
 */
import { createAgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";

const t0 = Date.now();

// ---- 1. 模型目录 ----
const modelRuntime = await ModelRuntime.create();
const all = modelRuntime.getModels();
console.log(`[catalog] 模型目录总数: ${all.length} (来自内置目录 + models.json)`);

const available = await modelRuntime.getAvailable();
console.log(`[auth]    鉴权可用模型 ${available.length} 个:`);
for (const m of available) {
	console.log(`          - ${m.provider}/${m.id}${m.reasoning ? " (reasoning)" : ""} ctx=${m.contextWindow ?? "?"}`);
}

if (available.length === 0) {
	console.error("\n[!] 没有可用模型。请先配置供应商: ~/.pi/agent/auth.json 或 models.json，或在 pi 中 /login");
	process.exit(1);
}

// ---- 2. 选模型: POC_PROVIDER/POC_MODEL > settings 默认 > 第一个可用 ----
const wantProvider = process.env.POC_PROVIDER;
const wantModel = process.env.POC_MODEL;
const target =
	(wantProvider && wantModel && available.find((m) => m.provider === wantProvider && m.id === wantModel)) ||
	available.find((m) => `${m.provider}/${m.id}` === "zhipu/glm-5.3-flash") ||
	available[0];

console.log(`\n[model]   使用 ${target.provider}/${target.id}  (耗时 ${Date.now() - t0}ms)`);

// ---- 3. 会话: 流式 + 工具事件 + token 用量 ----
const { session, modelFallbackMessage } = await createAgentSession({
	model: target,
	thinkingLevel: "off",
	modelRuntime,
});
if (modelFallbackMessage) console.log(`[fallback] ${modelFallbackMessage}`);
console.log(`[session] id=${session.sessionId}\n`);

let lastUsage = null;
session.subscribe((event) => {
	if (event.type === "message_update") {
		const a = event.assistantMessageEvent;
		if (a.type === "text_delta") process.stdout.write(a.delta);
		else if (a.type === "thinking_delta") process.stdout.write(".");
	} else if (event.type === "message_end" && event.message.role === "assistant") {
		lastUsage = event.message.usage ?? null;
	} else if (event.type === "tool_execution_start") {
		console.log(`\n  [tool] ${event.toolName} ${JSON.stringify(event.args).slice(0, 120)}`);
	} else if (event.type === "tool_execution_end") {
		console.log(`  [tool] ${event.toolName} -> ${event.isError ? "ERROR" : "ok"}`);
	} else if (event.type === "compaction_start") {
		console.log(`\n  [compaction] ${event.reason}`);
	} else if (event.type === "auto_retry_start") {
		console.log(`\n  [retry] ${event.attempt}/${event.maxAttempts} ${event.errorMessage}`);
	}
});

try {
	await session.prompt("用一句话介绍你自己，然后读取当前工作目录下有哪些文件（如果不行就说明原因）。");
} finally {
	console.log("\n");
	if (lastUsage) {
		const u = lastUsage;
		console.log(
			`[usage] input=${u.input} (cacheRead=${u.cacheRead ?? 0}) output=${u.output} cacheWrite=${u.cacheWrite ?? 0} — 本轮真实计费输入≈${u.input} tokens`,
		);
	}
	console.log(`[done] 总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s, 会话文件: ${session.sessionFile ?? "(memory)"}`);
	session.dispose();
}
