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
