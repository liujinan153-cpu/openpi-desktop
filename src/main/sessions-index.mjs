/**
 * P44：会话全文索引（SQLite FTS5 trigram，向 pi Desktop 取经）。
 * 现状（searchSessions）全量 readdir + 逐文件读 1MB，2s 预算上限——会话多了「搜不到」。
 * 本模块：userData/sessions-index.db（WAL）；files 表（mtime/size 增量比对）+ idx fts5 表
 * （tokenize=trigram 支持中文子串）；短查询（<3 字符，trigram 最小 token 限制）回退 LIKE。
 * 引擎不可用（native 模块 ABI 不符等）→ search() 返回 null，调用方 fallback 旧逻辑。
 * 测试隔离：OPENPI_INDEX_DB 环境变量覆盖 db 路径。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url); // ESM 里加载 CJS native 模块（better-sqlite3）

const MAX_TEXT_PER_FILE = 512 * 1024; // 单会话最多索引的文本量
const SYNC_BATCH = 200; // 单轮 sync 最多重索引的文件数（防启动卡顿；剩余下轮继续）

export class SessionIndex {
	/** @param {string} dbPath @param {string[]} searchRoots 会话目录（含 groups 子目录） */
	constructor(dbPath, searchRoots) {
		this.dbPath = dbPath;
		this.searchRoots = Array.isArray(searchRoots) ? searchRoots : [searchRoots];
		this.db = null;
		this.lastError = null;
		this.#open();
	}

	get available() {
		return this.db != null;
	}

	#open() {
		try {
			// 动态加载：ABI 不符时抛错 → 永久降级旧搜索（不阻断启动）
			const Database = require("better-sqlite3");
			fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
			const db = new Database(this.dbPath);
			db.pragma("journal_mode = WAL");
			db.exec(`
				CREATE TABLE IF NOT EXISTS files (
					path TEXT PRIMARY KEY, mtime INTEGER, size INTEGER,
					sid TEXT, cwd TEXT, title TEXT
				);
				CREATE VIRTUAL TABLE IF NOT EXISTS idx USING fts5(
					text, file UNINDEXED, tokenize='trigram'
				);
			`);
			this.db = db;
		} catch (err) {
			this.lastError = String(err?.message ?? err).slice(0, 200);
			console.error(`[session-index] 不可用，搜索降级为旧扫描: ${this.lastError}`);
		}
	}

	/** 全量增量同步：扫描 searchRoots，mtime/size 变化的文件重索引（每轮最多 SYNC_BATCH 个，最近优先） */
	syncRoot() {
		if (!this.db) return { indexed: 0, remaining: 0 };
		const candidates = [];
		for (const root of this.searchRoots) {
			let groups = [];
			try {
				groups = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name));
			} catch {
				continue;
			}
			for (const gdir of groups) {
				let files = [];
				try {
					files = fs.readdirSync(gdir).filter((f) => f.endsWith(".jsonl"));
				} catch {
					continue;
				}
				for (const f of files) {
					const full = path.join(gdir, f);
					try {
						const st = fs.statSync(full);
						const row = this.db.prepare("SELECT mtime, size FROM files WHERE path = ?").get(full);
						if (row && row.mtime === Math.round(st.mtimeMs) && row.size === st.size) continue;
						candidates.push({ full, mtime: Math.round(st.mtimeMs), size: st.size });
					} catch { /* 忽略 */ }
				}
			}
		}
		candidates.sort((a, b) => b.mtime - a.mtime); // 最近优先
		let n = 0;
		for (const c of candidates) {
			if (n >= SYNC_BATCH) break;
			if (this.#indexFile(c.full, c.mtime, c.size)) n++;
		}
		this.#pruneDeleted();
		return { indexed: n, remaining: candidates.length - n };
	}

	/** 单文件索引（agent_settled 后即时更新当前会话） */
	indexFile(full) {
		if (!this.db) return false;
		try {
			const st = fs.statSync(full);
			return this.#indexFile(full, Math.round(st.mtimeMs), st.size);
		} catch {
			return false;
		}
	}

	/** 搜索：返回与旧 searchSessions 同形数组；引擎不可用返回 null（调用方降级） */
	search(q, limit = 30) {
		if (!this.db) return null;
		const needle = String(q ?? "").trim();
		if (needle.length < 2) return [];
		try {
			const like = `%${needle.replace(/[%_\\]/g, " ")}%`; // LIKE 通配符直接剔掉（搜索词含 %/_ 场景极罕见，宁误不炸）
			const rows = needle.length >= 3
				? this.db.prepare(`SELECT text, file FROM idx WHERE idx MATCH ? LIMIT ?`).all(`"${needle.replace(/"/g, '""')}"`, limit * 4)
				: this.db.prepare(`SELECT text, file FROM idx WHERE text LIKE ? LIMIT ?`).all(like, limit * 4);
			// 按 file 去重（单会话取首条匹配，对齐旧行为），mtime 排序
			const byFile = new Map();
			const low = needle.toLowerCase();
			for (const r of rows) {
				if (byFile.has(r.file)) continue;
				const meta = this.db.prepare("SELECT sid, cwd, title, mtime FROM files WHERE path = ?").get(r.file);
				if (!meta) continue;
				const at = r.text.toLowerCase().indexOf(low);
				const from = Math.max(0, at - 40);
				const preview = at >= 0
					? (from > 0 ? "…" : "") + r.text.slice(from, at + needle.length + 60) + (at + needle.length + 60 < r.text.length ? "…" : "")
					: r.text.slice(0, 100);
				byFile.set(r.file, { file: r.file, id: meta.sid, cwd: meta.cwd ?? "", mtime: meta.mtime, preview, title: meta.title ?? "" });
				if (byFile.size >= limit) break;
			}
			return [...byFile.values()].sort((a, b) => b.mtime - a.mtime);
		} catch (err) {
			console.error(`[session-index] search 失败: ${err.message ?? err}`);
			return null;
		}
	}

	/** 索引单个会话文件：解析 head + 消息文本 → 重建 fts 行 */
	#indexFile(full, mtime, size) {
		try {
			const { sid, cwd, title, texts } = this.#parseSession(full);
			if (!sid) return false; // 头行都没解析出来（空/坏文件）不索引
			const tx = this.db.transaction(() => {
				this.db.prepare("DELETE FROM idx WHERE file = ?").run(full);
				this.db.prepare("INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?, ?, ?)").run(full, mtime, size, sid, cwd, title);
				const ins = this.db.prepare("INSERT INTO idx (text, file) VALUES (?, ?)");
				let used = 0;
				for (const t of texts) {
					if (used + t.length > MAX_TEXT_PER_FILE) break;
					ins.run(t, full);
					used += t.length;
				}
			});
			tx();
			return true;
		} catch (err) {
			console.error(`[session-index] 索引失败 ${path.basename(full)}: ${err.message ?? err}`);
			return false;
		}
	}

	/** 解析会话文件：头行（session）+ 消息文本（user/assistant） */
	#parseSession(full) {
		let sid = null, cwd = "", title = "";
		const texts = [];
		const content = fs.readFileSync(full, "utf8");
		for (const line of content.split("\n")) {
			if (!line) continue;
			let e;
			try {
				e = JSON.parse(line);
			} catch {
				continue;
			}
			if (!sid && e.type === "session") {
				sid = e.id ?? null;
				cwd = e.cwd ?? "";
				title = e.title ?? "";
			}
			if (e.type === "message" && e.message?.role) {
				const c = e.message.content;
				const txt = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join(" ") : "";
				if (txt.trim()) texts.push(txt);
			}
		}
		return { sid, cwd, title, texts };
	}

	/** 清理已删除文件的索引行 */
	#pruneDeleted() {
		try {
			const all = this.db.prepare("SELECT path FROM files").all();
			for (const r of all) {
				if (!fs.existsSync(r.path)) {
					this.db.prepare("DELETE FROM files WHERE path = ?").run(r.path);
					this.db.prepare("DELETE FROM idx WHERE file = ?").run(r.path);
				}
			}
		} catch { /* 尽力而为 */ }
	}

	close() {
		try { this.db?.close(); } catch { /* 尽力 */ }
		this.db = null;
	}
}
