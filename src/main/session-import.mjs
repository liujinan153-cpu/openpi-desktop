/**
 * P64⑧：外部会话导入（截流竞品用户）。
 * 起步版：Claude Code（~/.claude/projects/<slug>/*.jsonl）→ 转成 pi 原生会话格式写入
 * ~/.pi/agent/sessions/<slug>--imported/，listSessions 天然可见（只读回看，可续聊由 pi SDK 决定）。
 * 官方 pi 用户零成本（同源目录）；Codex/OpenCode 检测到目录即报可用（转换后续批）。
 * 格式映射：{type:"user"|"assistant", message:{content:string|[{type:"text",text}]}} → pi 的
 * {type:"message", message:{role, content}}；tool_use/tool_result/thinking 起步版跳过。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const HOME = process.env.PI_HOME || os.homedir(); // e2e 隔离入口；USERPROFILE 覆写会让 Electron 静默死，不能用于此
const SESSIONS_ROOT = process.env.OPENPI_SESSIONS_ROOT || path.join(HOME, ".pi", "agent", "sessions"); // 与 main.mjs 的会话根保持同一优先级

/** 探测可导入的外部来源：返回 [{ kind, dir, count }] */
export function detectImportSources() {
	const out = [];
	const home = HOME;
	// Claude Code：~/.claude/projects/<项目路径slug>/<uuid>.jsonl
	const cc = path.join(home, ".claude", "projects");
	let ccCount = 0;
	let ccDir = null;
	try {
		for (const d of fs.readdirSync(cc, { withFileTypes: true })) {
			if (!d.isDirectory()) continue;
			const gdir = path.join(cc, d.name);
			for (const f of fs.readdirSync(gdir)) {
				if (f.endsWith(".jsonl")) ccCount++;
			}
		}
		if (ccCount > 0) ccDir = cc;
	} catch { /* 未安装 */ }
	if (ccDir) out.push({ kind: "claude-code", dir: ccDir, count: ccCount });
	// Codex CLI：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl（P69）
	const codexDir = path.join(home, ".codex", "sessions");
	let codexCount = 0;
	try {
		codexCount = walkFiles(codexDir, ".jsonl").length;
	} catch { /* 未安装 */ }
	if (codexCount > 0) out.push({ kind: "codex", dir: codexDir, count: codexCount });
	// OpenCode：storage 目录（XDG / Win LOCALAPPDATA / ~/.opencode 三候选，P69）
	const ocCandidates = [
		path.join(home, ".local", "share", "opencode", "storage"),
		path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "opencode", "storage"),
		path.join(home, ".opencode", "storage"),
	];
	for (const st of ocCandidates) {
		let ocCount = 0;
		try {
			ocCount = walkFiles(path.join(st, "session"), ".json").length;
		} catch { /* 该布局不存在 */ }
		if (ocCount > 0) {
			out.push({ kind: "opencode", dir: st, count: ocCount });
			break;
		}
	}
	return out;
}

/** 递归收集指定扩展名文件（Codex 按年/月/日嵌套，OpenCode storage 任意层） */
function walkFiles(dir, ext) {
	const out = [];
	for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, d.name);
		if (d.isDirectory()) out.push(...walkFiles(full, ext));
		else if (d.name.endsWith(ext)) out.push(full);
	}
	return out;
}

/** 解析 Claude Code 单个 jsonl → [{role, text}]（只取 text 对话；跳过工具/思考块） */
export function parseClaudeJsonl(full) {
	const msgs = [];
	let raw = "";
	try {
		raw = fs.readFileSync(full, "utf8");
	} catch {
		return msgs;
	}
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e.type !== "user" && e.type !== "assistant") continue;
		if (e.isMeta) continue; // Claude Code 的 meta 行（命令回显等）
		const c = e.message?.content;
		let text = "";
		if (typeof c === "string") text = c;
		else if (Array.isArray(c)) {
			text = c.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join("\n");
		}
		text = text.trim();
		if (!text) continue;
		if (text.startsWith("<") && text.includes(">")) {
			// 系统注入的 XML-ish 块（command-name 等）粗滤：掐掉纯标签行
			const stripped = text.replace(/<[^>]{1,120}>/g, "").trim();
			if (!stripped) continue;
		}
		msgs.push({ role: e.type === "user" ? "user" : "assistant", text, ts: e.timestamp });
	}
	return msgs;
}

/** 导入一个 Claude Code 会话文件 → 返回 { ok, id, file, msgs }；已导入过（源文件 mtime 未变）跳过 */
export function importClaudeSession(full) {
	const msgs = parseClaudeJsonl(full);
	if (msgs.length === 0) return { ok: false, skip: "no-text-msgs", id: null };
	// 幂等标记：目标文件名 = 源文件 hash 前缀 + 源文件名
	const srcName = path.basename(full, ".jsonl");
	const short = crypto.createHash("md5").update(full).digest("hex").slice(0, 8);
	// cwd 从源目录名还原（Claude Code slug：C--Users-xxx-proj → C:/Users/xxx/proj 不可精确还原，存源 slug 即可）
	const srcDir = path.basename(path.dirname(full));
	const cwd = srcDir; // 保留原始 slug 供识别；回看不需要真实路径
	const grp = path.join(SESSIONS_ROOT, `${srcDir.slice(0, 60)}--imported`);
	fs.mkdirSync(grp, { recursive: true });
	const id = `claude-${short}-${srcName.slice(0, 12)}`;
	const file = path.join(grp, `${Date.now()}_${id}.jsonl`);
	// 幂等：已存在同 id 会话则跳过
	let exists = false;
	try {
		for (const f of fs.readdirSync(grp)) {
			if (f.includes(id)) {
				exists = true;
				break;
			}
		}
	} catch { /* 首次 */ }
	if (exists) return { ok: false, skip: "already-imported", id };
	const sid = crypto.randomUUID();
	const head = { type: "session", id: sid, cwd, timestamp: Date.now(), openpiImported: { from: "claude-code", src: full } };
	const lines = [JSON.stringify(head)];
	for (const m of msgs) {
		lines.push(JSON.stringify({ type: "message", message: { role: m.role, content: m.text }, timestamp: m.ts ? Date.parse(m.ts) : Date.now() }));
	}
	fs.writeFileSync(file, lines.join("\n") + "\n");
	return { ok: true, id, file, msgs: msgs.length };
}

/** 全量导入 Claude Code：返回 { imported, skipped, failed } */
export function importAllClaude() {
	let imported = 0;
	let skipped = 0;
	let failed = 0;
	const cc = path.join(HOME, ".claude", "projects");
	try {
		for (const d of fs.readdirSync(cc, { withFileTypes: true })) {
			if (!d.isDirectory()) continue;
			const gdir = path.join(cc, d.name);
			for (const f of fs.readdirSync(gdir)) {
				if (!f.endsWith(".jsonl")) continue;
				try {
					const r = importClaudeSession(path.join(gdir, f));
					if (r.ok) imported++;
					else skipped++;
				} catch {
					failed++;
				}
			}
		}
	} catch {
		// 来源不存在
	}
	return { imported, skipped, failed };
}

/* ================= P69：Codex / OpenCode 导入 ================= */

/** 通用写入：把 [{role,text,ts}] 转成 pi 原生会话格式（复用 Claude 的幂等/目录约定） */
function writeImportedSession(kind, srcFull, msgs, cwdLabel) {
	if (msgs.length === 0) return { ok: false, skip: "no-text-msgs", id: null };
	const srcName = path.basename(srcFull).replace(/\.[a-z]+$/i, "");
	const short = crypto.createHash("md5").update(srcFull).digest("hex").slice(0, 8);
	const srcDir = path.basename(path.dirname(srcFull));
	const grp = path.join(SESSIONS_ROOT, `${cwdLabel || srcDir}`.slice(0, 60) + "--imported");
	fs.mkdirSync(grp, { recursive: true });
	const id = `${kind}-${short}-${srcName.slice(0, 12)}`;
	let exists = false;
	try {
		for (const f of fs.readdirSync(grp)) {
			if (f.includes(id)) { exists = true; break; }
		}
	} catch { /* 首次 */ }
	if (exists) return { ok: false, skip: "already-imported", id };
	const sid = crypto.randomUUID();
	const head = { type: "session", id: sid, cwd: cwdLabel || srcDir, timestamp: Date.now(), openpiImported: { from: kind, src: srcFull } };
	const lines = [JSON.stringify(head)];
	for (const m of msgs) {
		lines.push(JSON.stringify({ type: "message", message: { role: m.role, content: m.text }, timestamp: m.ts ? Date.parse(m.ts) : Date.now() }));
	}
	fs.writeFileSync(path.join(grp, `${Date.now()}_${id}.jsonl`), lines.join("\n") + "\n");
	return { ok: true, id, msgs: msgs.length };
}

/** XML-ish 系统注入块粗滤（environment_context / permissions instructions 等）：掐标签后全空则丢 */
function isPureMarkup(text) {
	if (!(text.startsWith("<") && text.includes(">"))) return false;
	return !text.replace(/<[^>]{1,120}>/g, "").trim();
}
/** Codex 系统注入块（裸文本会残留，如 environment_context 里的 cwd 值——按已知首标签直接判） */
const CODEX_SYSTEM_RE = /^\s*<(environment_context|permissions|user_instructions|turn_context|task_context|schedule_prompt)/i;


/** 解析 Codex rollout jsonl → [{role,text,ts}]（response_item.message；input_text/output_text/text 全兼容） */
export function parseCodexJsonl(full) {
	const msgs = [];
	let raw = "";
	try { raw = fs.readFileSync(full, "utf8"); } catch { return msgs; }
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let e;
		try { e = JSON.parse(line); } catch { continue; }
		if (e.type !== "response_item") continue;
		const p = e.payload;
		if (!p || p.type !== "message") continue;
		if (p.role !== "user" && p.role !== "assistant") continue; // developer/tool 跳过
		const c = p.content;
		let text = "";
		if (typeof c === "string") text = c;
		else if (Array.isArray(c)) {
			text = c.filter((b) => b && (b.type === "input_text" || b.type === "output_text" || b.type === "text")).map((b) => String(b.text ?? "")).join("\n");
		}
		text = String(text ?? "").trim();
		if (!text || isPureMarkup(text) || CODEX_SYSTEM_RE.test(text)) continue;
		msgs.push({ role: p.role, text, ts: e.timestamp });
	}
	return msgs;
}

/** 导入一个 Codex 会话 */
export function importCodexSession(full) {
	return writeImportedSession("codex", full, parseCodexJsonl(full), "codex");
}

// 全量导入 Codex：~/.codex/sessions 下任意层级的 rollout jsonl
export function importAllCodex() {
	let imported = 0, skipped = 0, failed = 0;
	try {
		for (const full of walkFiles(path.join(HOME, ".codex", "sessions"), ".jsonl")) {
			try {
				const r = importCodexSession(full);
				if (r.ok) imported++; else skipped++;
			} catch { failed++; }
		}
	} catch { /* 来源不存在 */ }
	return { imported, skipped, failed };
}

/** OpenCode message/part 布局防御式读取（版本差异大：探到什么用什么） */
function readOpencodeSessionMsgs(storageDir, sessFile) {
	let sess = {};
	try { sess = JSON.parse(fs.readFileSync(sessFile, "utf8")); } catch { return []; }
	const sid = sess.id ?? path.basename(sessFile, ".json");
	const out = [];
	// 布局 A：message/<sid>/<msgID>.json（role 内嵌）+ part/<msgID>/*.json
	// 布局 B：message/<sid>/<msgID>/info.json + part/<sid>/<msgID>/*.json
	// 布局 C：message/<sid>/*.json 里的 content 数组直接带文本
	let msgDir = null;
	try { msgDir = path.join(storageDir, "message", sid); fs.readdirSync(msgDir); } catch { return []; }
	for (const entry of fs.readdirSync(msgDir, { withFileTypes: true })) {
		let role = null, msgId = null, directParts = null;
		if (entry.isDirectory()) {
			// 布局 B：目录里 info.json
			msgId = entry.name;
			try {
				const info = JSON.parse(fs.readFileSync(path.join(msgDir, msgId, "info.json"), "utf8"));
				role = info.role ?? null;
				directParts = Array.isArray(info.parts) ? info.parts : null;
			} catch { /* 跳过 */ }
		} else if (entry.name.endsWith(".json")) {
			// 布局 A/C：单文件
			msgId = entry.name.replace(/\.json$/, "");
			try {
				const info = JSON.parse(fs.readFileSync(path.join(msgDir, entry.name), "utf8"));
				role = info.role ?? null;
				directParts = Array.isArray(info.parts) ? info.parts : (Array.isArray(info.content) ? info.content : null);
			} catch { /* 跳过 */ }
		}
		if (!role || (role !== "user" && role !== "assistant")) continue;
		const texts = [];
		for (const part of directParts ?? []) {
			if (part?.type === "text" && part.text) texts.push(String(part.text));
		}
		// parts 落盘布局：part/<msgID>/*.json 或 part/<sid>/<msgID>/*.json
		for (const pdir of [path.join(storageDir, "part", msgId), path.join(storageDir, "part", sid, msgId)]) {
			if (texts.length) break;
			let files = [];
			try { files = fs.readdirSync(pdir); } catch { continue; }
			for (const f of files) {
				if (!f.endsWith(".json")) continue;
				try {
					const part = JSON.parse(fs.readFileSync(path.join(pdir, f), "utf8"));
					if (part?.type === "text" && part.text) texts.push(String(part.text));
				} catch { /* 跳过坏文件 */ }
			}
		}
		const text = texts.join("\n").trim();
		if (!text || isPureMarkup(text) || CODEX_SYSTEM_RE.test(text)) continue;
		const ts = sess.time?.[role === "user" ? "created" : "updated"] ?? sess.time?.created;
		out.push({ role, text, ts });
	}
	out.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
	return out;
}

/** 全量导入 OpenCode：三候选 storage 布局逐个试 */
export function importAllOpenCode() {
	let imported = 0, skipped = 0, failed = 0;
	const ocCandidates = [
		path.join(HOME, ".local", "share", "opencode", "storage"),
		path.join(process.env.LOCALAPPDATA ?? path.join(HOME, "AppData", "Local"), "opencode", "storage"),
		path.join(HOME, ".opencode", "storage"),
	];
	for (const st of ocCandidates) {
		let sessFiles = [];
		try { sessFiles = walkFiles(path.join(st, "session"), ".json"); } catch { continue; }
		if (!sessFiles.length) continue;
		for (const sf of sessFiles) {
			try {
				const msgs = readOpencodeSessionMsgs(st, sf);
				const title = (() => { try { return JSON.parse(fs.readFileSync(sf, "utf8")).title; } catch { return null; } })();
				const r = writeImportedSession("opencode", sf, msgs, `opencode-${title ? title.slice(0, 40) : "sessions"}`);
				if (r.ok) imported++; else skipped++;
			} catch { failed++; }
		}
		return { imported, skipped, failed }; // 第一个命中的布局即认为该装的版本，避免跨布局重复导入
	}
	return { imported, skipped, failed };
}
