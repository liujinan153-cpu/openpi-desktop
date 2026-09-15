/**
 * P47 内置联网检索工具（customTools 注入，SDK 零改动）
 *
 *  - webfetch：抓取网页 → 剥 HTML 标签转纯文本 → 截断返回（只读网络操作，全档位可用）
 *  - websearch：Tavily API（可配 key）→ 无 key 兜底 DuckDuckGo lite HTML 解析
 *
 * SSRF 防护：仅 http/https；拒绝环回/内网/链路本地/元数据地址（按 hostname 字符串）。
 * 诚实边界：未做 DNS 解析后二次校验（DNS rebinding 理论上可绕过），桌面单机场景风险可接受。
 */
import { Type } from "typebox";

const MAX_CHARS = 20000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 OpenPi/0.40";

/** 内网/环回/元数据主机名黑名单 */
function isBlockedHost(hostname) {
	const h = hostname.toLowerCase().replace(/\.$/, "");
	if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h === "::1" || h === "[::1]") return true;
	if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^0\./.test(h)) return true;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
	if (h === "metadata.google.internal" || h.endsWith(".svc") || h.endsWith(".cluster.local")) return true;
	return false;
}

/** HTML → 纯文本（无第三方依赖） */
function htmlToText(html) {
	let s = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, " ");
	s = s
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&#x?[\da-f]+;/gi, " ");
	return s.replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}

function truncate(text, max = MAX_CHARS) {
	if (text.length <= max) return text;
	return text.slice(0, max) + `\n\n[内容已截断，原文共 ${text.length} 字符]`;
}

function proxyFetch(url, opts = {}) {
	// 尊重设置里的代理（Node fetch 默认不走系统代理）；无代理配置则直连
	return fetch(url, { signal: AbortSignal.timeout(30000), redirect: "follow", ...opts });
}

const webfetchTool = {
	name: "webfetch",
	label: "抓取网页",
	description:
		"抓取指定 URL 的网页内容，转为纯文本返回给模型（自动剥除 HTML 标签，超长截断）。" +
		"仅支持 http/https 公网地址。适合读取文档、文章、API 说明等页面。只读操作。",
	promptSnippet: "- webfetch: 抓取网页并转纯文本（联网读文档/文章时用）",
	parameters: Type.Object({
		url: Type.String({ description: "要抓取的完整 URL（http/https）" }),
		maxChars: Type.Optional(Type.Number({ description: `返回文本最大字符数，默认 ${MAX_CHARS}` })),
	}),
	async execute(_id, params, signal) {
		let u;
		try {
			u = new URL(params.url);
		} catch {
			return { content: [{ type: "text", text: `无效 URL：${params.url}` }], details: { ok: false } };
		}
		if (u.protocol !== "http:" && u.protocol !== "https:") {
			return { content: [{ type: "text", text: `仅支持 http/https，收到 ${u.protocol}` }], details: { ok: false } };
		}
		if (isBlockedHost(u.hostname)) {
			return { content: [{ type: "text", text: `拒绝访问内网/保留地址：${u.hostname}` }], details: { ok: false } };
		}
		try {
			const res = await proxyFetch(u.href, { headers: { "User-Agent": UA, Accept: "text/html,application/json;q=0.9,*/*;q=0.8" }, signal });
			const ctype = res.headers.get("content-type") ?? "";
			if (!res.ok) {
				return { content: [{ type: "text", text: `HTTP ${res.status} ${res.statusText} — ${u.href}` }], details: { ok: false } };
			}
			const raw = await res.text();
			let text;
			if (ctype.includes("html")) text = htmlToText(raw);
			else if (ctype.includes("json")) {
				try { text = JSON.stringify(JSON.parse(raw), null, 1); } catch { text = raw; }
			} else text = raw;
			return {
				content: [{ type: "text", text: `${u.href}（HTTP ${res.status}，${ctype.split(";")[0] || "unknown"}）\n\n${truncate(text, params.maxChars)}` }],
				details: { ok: true, bytes: raw.length },
			};
		} catch (err) {
			return { content: [{ type: "text", text: `抓取失败：${err?.message ?? err}` }], details: { ok: false } };
		}
	},
};

/** Tavily key 读取：环境变量 → 设置文件 ~/.pi/agent/openpi-settings.json 的 web.tavilyKey */
function tavilyKey() {
	return process.env.OPENPI_TAVILY_KEY || globalThis.__openpiSettings?.web?.tavilyKey || "";
}

async function tavilySearch(query, count) {
	const key = tavilyKey();
	if (!key) return null;
	const base = process.env.OPENPI_TAVILY_BASE || "https://api.tavily.com"; // 测试后门：指向本地 mock
	const res = await proxyFetch(base + "/search", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ api_key: key, query, max_results: count }),
	});
	if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
	const j = await res.json();
	return (j.results ?? []).map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${String(r.content ?? "").slice(0, 600)}`).join("\n\n");
}

/** DuckDuckGo lite HTML 解析（无 key 兜底；被墙网络下会失败，属预期） */
async function ddgSearch(query, count) {
	const res = await proxyFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { "User-Agent": UA } });
	if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
	const html = await res.text();
	const results = [];
	const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
	let m;
	while ((m = re.exec(html)) && results.length < count) {
		let url = m[1];
		const sm = /uddg=([^&]+)/.exec(url);
		if (sm) url = decodeURIComponent(sm[1]);
		results.push(`${results.length + 1}. ${htmlToText(m[2])}\n   URL: ${url}`);
	}
	return results.join("\n\n");
}

const websearchTool = {
	name: "websearch",
	label: "联网搜索",
	description:
		"联网搜索，返回网页结果标题与链接列表（含摘要）。查询用英文效果通常更好。" +
		"拿到链接后可用 webfetch 读取正文。只读操作。",
	promptSnippet: "- websearch: 联网搜索返回结果列表（配合 webfetch 读正文）",
	parameters: Type.Object({
		query: Type.String({ description: "搜索关键词" }),
		count: Type.Optional(Type.Number({ description: "结果条数，默认 6，上限 10" })),
	}),
	async execute(_id, params, signal) {
		const count = Math.min(Math.max(1, params.count ?? 6), 10);
		let text = null, via = "";
		try {
			text = await tavilySearch(params.query, count);
			if (text !== null) via = "tavily";
		} catch (err) {
			text = null;
			via = `tavily 失败(${err?.message ?? err})`;
		}
		if (text === null) {
			try {
				text = await ddgSearch(params.query, count);
				via += (via ? " → " : "") + "duckduckgo";
			} catch (err) {
				return {
					content: [{ type: "text", text: `搜索失败（${[via, `duckduckgo: ${err?.message ?? err}`].filter(Boolean).join("；")}）。提示：国内网络下 DuckDuckGo 通常不可达，可在 设置 → 联网检索 配置 Tavily API key（每月免费 1000 次）后重试。` }],
					details: { ok: false },
				};
			}
		}
		if (!text) text = "无搜索结果，试试更具体的关键词。";
		return { content: [{ type: "text", text: `搜索「${params.query}」（via ${via}）：\n\n${text}` }], details: { ok: true } };
	},
};

export const webTools = [webfetchTool, websearchTool];

/** 设置注入（main 进程读设置文件后经 boot 传入 worker） */
export function setWebSettings(settings) {
	globalThis.__openpiSettings = settings ?? {};
}
