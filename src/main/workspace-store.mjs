/**
 * P41：沙箱工作区 store（向 pi Desktop 取经，混合式改造）
 *
 * 设计（尊重「产物收进共享工作区」的产品理念，不照搬 pi 的 per-session sandbox）：
 * - 主会话：维持默认共享工作区 ~/openpi-workspace（产物跨会话复用）
 * - P30 后台任务：per-task 沙箱目录 <root>/{id}/ + .openpi-sandbox.json 元数据，
 *   与主工作区完全隔离；完成后通知里带路径，产物需要保留时 AI/用户自行复制
 * - kind: "task"（自动创建）；预留 "project"（用户选目录，不需要本 store）
 * - 清理：45 天不活跃（mtime）自动删除，启动时执行；进行中任务不受影响（目录刚写过）
 *
 * root 可用 OPENPI_SANDBOX_ROOT 环境变量覆盖（e2e 隔离用）。
 */
import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";

export const SANDBOX_META = ".openpi-sandbox.json";
const RETENTION_DAYS = 45;

/** 沙箱根目录（app.getPath("userData") 由调用方传入，避免本模块依赖 electron） */
export function sandboxRoot(userDataDir) {
	return process.env.OPENPI_SANDBOX_ROOT || path.join(userDataDir, "sandbox-workspaces");
}

/** label → 安全目录内可读文本（元数据里存原文，目录名用 id 就够） */
export function makeId() {
	return String(randomInt(10_000_000, 99_999_999)); // 8 位随机数字，对齐 pi
}

/** 创建任务沙箱目录 + 元数据 */
export function createSandbox(root, label) {
	const id = makeId();
	const dir = path.join(root, id);
	fs.mkdirSync(dir, { recursive: true });
	const meta = {
		id,
		label: String(label ?? "").slice(0, 80) || "后台任务",
		createdAt: new Date().toISOString(),
		kind: "task",
		sessionId: null,
		sessionFile: null,
	};
	fs.writeFileSync(path.join(dir, SANDBOX_META), JSON.stringify(meta, null, 2));
	return { dir, meta };
}

/** 会话创建后回填绑定（对齐 pi 的 bindSession） */
export function bindSession(dir, { sessionId, sessionFile }) {
	try {
		const metaPath = path.join(dir, SANDBOX_META);
		const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
		meta.sessionId = sessionId ?? null;
		meta.sessionFile = sessionFile ?? null;
		fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
	} catch { /* 元数据写失败不影响任务本身 */ }
}

/** 读取某目录的沙箱元数据（非沙箱目录返回 null） */
export function readMeta(dir) {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, SANDBOX_META), "utf8"));
	} catch {
		return null;
	}
}

/** 清理过期沙箱（mtime 超过保留期即删；返回删除的 id 列表） */
export function cleanupExpired(root, days = RETENTION_DAYS) {
	const removed = [];
	let entries;
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return removed;
	}
	const cutoff = Date.now() - days * 24 * 3600 * 1000;
	for (const ent of entries) {
		if (!ent.isDirectory()) continue;
		const dir = path.join(root, ent.name);
		try {
			const st = fs.statSync(dir);
			if (st.mtimeMs >= cutoff) continue;
			// 双保险：正在使用的任务目录 mtime 一定是新的；再确认元数据齐全
			const meta = readMeta(dir);
			if (!meta || meta.kind === "task") {
				fs.rmSync(dir, { recursive: true, force: true });
				removed.push(meta?.id ?? ent.name);
			}
		} catch { /* 单个目录失败不影响其余 */ }
	}
	return removed;
}
