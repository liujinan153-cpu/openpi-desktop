/**
 * config-store —— 配置中心（M1）
 *
 * 原则「配置即契约」：只写 Pi 的标准文件
 *   - ~/.pi/agent/models.json  → 自定义/本地供应商（L2/L4）
 *   - ~/.pi/agent/auth.json    → API 密钥（L1，0600）
 * 不修改 Pi 源码；CLI pi 与桌面端双向兼容。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const MODELS_JSON = path.join(AGENT_DIR, "models.json");
const AUTH_JSON = path.join(AGENT_DIR, "auth.json");

/** 合法 API 形态（与 pi models.md 一致） */
export const APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];

/** 本地运行时预设（L4 模板） */
export const LOCAL_PRESETS = {
	ollama: { label: "Ollama", baseUrl: "http://localhost:11434/v1", apiKey: "ollama", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, hint: "ollama pull qwen3:8b 后即可使用" },
	"lm-studio": { label: "LM Studio", baseUrl: "http://localhost:1234/v1", apiKey: "lm-studio", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, hint: "Developer → Start Server" },
	vllm: { label: "vLLM", baseUrl: "http://localhost:8000/v1", apiKey: "vllm", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, hint: "vllm serve <model> --port 8000" },
	"llama-cpp": { label: "llama.cpp", baseUrl: "http://localhost:8080/v1", apiKey: "llama.cpp", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, hint: "llama-server -m model.gguf --port 8080" },
};

function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}

function maskKey(k) {
	if (!k) return "";
	if (k.length <= 12) return k.slice(0, 3) + "****";
	return k.slice(0, 8) + "…" + k.slice(-4);
}

/** 汇总配置视图（密钥打码） */
export function getConfig() {
	const models = readJson(MODELS_JSON, { providers: {} });
	const auth = readJson(AUTH_JSON, {});
	const providers = {};
	for (const [id, p] of Object.entries(models.providers ?? {})) {
		providers[id] = {
			id,
			name: p.name ?? id,
			baseUrl: p.baseUrl ?? "",
			api: p.api ?? "openai-completions",
			apiKeyMasked: p.apiKey ? maskKey(p.apiKey) : "",
			hasKey: Boolean(p.apiKey || auth[id]?.key),
			compat: p.compat ?? null,
			models: (p.models ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id })),
		};
	}
	return {
		agentDir: AGENT_DIR,
		providers,
		authProviders: Object.fromEntries(Object.entries(auth).map(([k, v]) => [k, { type: v?.type, keyMasked: maskKey(v?.key) }])),
		presets: LOCAL_PRESETS,
		apis: APIS,
	};
}

/** 保存/更新自定义供应商（合并进 models.json，写前备份） */
export function saveProvider(id, patch) {
	if (!/^[\w.-]{1,64}$/.test(id)) throw new Error("非法供应商 ID");
	const models = readJson(MODELS_JSON, { providers: {} });
	if (!models.providers) models.providers = {};
	backupOnce(MODELS_JSON);

	const prev = models.providers[id] ?? {};
	const next = {
		...prev,
		name: patch.name || prev.name || id,
		baseUrl: (patch.baseUrl || prev.baseUrl || "").replace(/\/+$/, ""),
		api: APIS.includes(patch.api) ? patch.api : prev.api ?? "openai-completions",
		models: (patch.models ?? prev.models ?? []).map((m) => (typeof m === "string" ? { id: m } : m)),
	};
	// apiKey：空值 = 保留原值；显式 "-" = 删除
	if (patch.apiKey === "-") delete next.apiKey;
	else if (patch.apiKey) next.apiKey = patch.apiKey;
	if (patch.compat) next.compat = { ...(prev.compat ?? {}), ...patch.compat };

	models.providers[id] = next;
	writeJson(MODELS_JSON, models);
	return getConfig();
}

export function deleteProvider(id) {
	const models = readJson(MODELS_JSON, { providers: {} });
	backupOnce(MODELS_JSON);
	delete models.providers?.[id];
	writeJson(MODELS_JSON, models);
	return getConfig();
}

/** L1：写入 auth.json（0600） */
export function saveKey(providerId, key) {
	if (!/^[\w.-]{1,64}$/.test(providerId)) throw new Error("非法供应商 ID");
	const auth = readJson(AUTH_JSON, {});
	backupOnce(AUTH_JSON);
	auth[providerId] = { ...(auth[providerId] ?? {}), type: "api", key: String(key).trim() };
	writeJson(AUTH_JSON, auth, 0o600);
	return getConfig();
}

function writeJson(file, data, mode = 0o644) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode });
	try {
		fs.chmodSync(file, mode);
	} catch { /* Windows 忽略 */ }
}

let backedUp = new Set();
function backupOnce(file) {
	if (backedUp.has(file) || !fs.existsSync(file)) return;
	try {
		fs.copyFileSync(file, file + ".bak");
		backedUp.add(file);
	} catch { /* 尽力而为 */ }
}

/** 连通性测试：GET {baseUrl}/models（OpenAI 兼容端点通用）。
 *  apiKey 可为空：给定 providerId 时自动用已存真实密钥（渲染层只见打码值）。 */
export async function testEndpoint({ baseUrl, apiKey, providerId }) {
	const t0 = Date.now();
	const base = String(baseUrl ?? "").replace(/\/+$/, "");
	if (!/^https?:\/\//.test(base)) return { ok: false, ms: 0, error: "baseUrl 需以 http(s):// 开头" };
	let key = apiKey && apiKey !== "-" ? apiKey : "";
	if (!key && providerId) {
		const models = readJson(MODELS_JSON, { providers: {} });
		const auth = readJson(AUTH_JSON, {});
		key = models.providers?.[providerId]?.apiKey ?? auth[providerId]?.key ?? "";
	}
	try {
		const res = await fetch(base + "/models", {
			headers: key ? { Authorization: `Bearer ${key}` } : {},
			signal: AbortSignal.timeout(8000),
		});
		const ms = Date.now() - t0;
		if (!res.ok) return { ok: false, ms, error: `HTTP ${res.status}` };
		const body = await res.json().catch(() => ({}));
		const ids = (body.data ?? body.models ?? []).map((m) => m.id ?? m.name).filter(Boolean);
		return { ok: true, ms, count: ids.length, sample: ids.slice(0, 12) };
	} catch (e) {
		return { ok: false, ms: Date.now() - t0, error: String(e.cause?.code ?? e.message ?? e).slice(0, 120) };
	}
}
