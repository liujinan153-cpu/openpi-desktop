/**
 * P55 项目记忆：跨会话记住项目约定/决策/偏好。
 * - 存储：<workspace>/.openpi/MEMORY.md（纯文本，Agent 自主维护，无 UI 面板）
 * - 工具：memory_read（只读直通）+ memory_write（追加/覆写，未知写类走通用审批）
 * - 注入：before_agent_start 时把 MEMORY.md 摘要（超长截断）拼进 system prompt
 * 设计对齐 git-checkpoint.mjs：cwd 必须经 setMemoryWorkspace 显式注入（坐坑 #105）。
 */
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";

let _workspace = null;

export function setMemoryWorkspace(ws) {
	_workspace = ws || null;
	console.error(`[p55] 记忆工作目录: ${_workspace}`);
}

function memoryFile() {
	return _workspace ? path.join(_workspace, ".openpi", "MEMORY.md") : null;
}

export function memoryRead() {
	const f = memoryFile();
	if (!f || !fs.existsSync(f)) return "";
	try {
		return fs.readFileSync(f, "utf8");
	} catch {
		return "";
	}
}

/** MEMORY.md 摘要注入：超长截断头部（保留最新约定需 AI 自己在写时维护顺序） */
export function memorySystemPrompt() {
	const content = memoryRead();
	if (!content.trim()) return "";
	const truncated = content.length > 2000 ? content.slice(0, 2000) + "\n…（已截断，全文用 memory_read 查看）" : content;
	return (
		"\n\n## 项目记忆（MEMORY.md，跨会话生效）\n" +
		"以下是本项目此前沉淀的记忆（约定/决策/偏好）：\n\n" +
		truncated +
		"\n\n本次任务请遵守其中的既有约定；若产生新的项目级约定/决策/用户偏好，用 memory_write 追加记录（保持精炼，一行一条）。\n"
	);
}

const OK = (text) => ({ content: [{ type: "text", text }], details: { ok: true } });
const BAD = (text) => ({ content: [{ type: "text", text }], details: { ok: false } });

export const memoryTools = [
	{
		name: "memory_read",
		label: "读项目记忆",
		description:
			"读取本项目的记忆文件（<workspace>/.openpi/MEMORY.md，含历史约定/决策/用户偏好）。开始处理任务前若怀疑有相关约定，先读它。",
		parameters: Type.Object({}),
		execute(_id) {
			const f = memoryFile();
			if (!f) return BAD("当前会话未绑定工作区，项目记忆不可用。");
			if (!fs.existsSync(f)) return OK("（项目记忆为空——尚无 MEMORY.md。若有值得沉淀的约定/决策，可用 memory_write 记录。）");
			return OK(fs.readFileSync(f, "utf8") || "（项目记忆为空）");
		},
	},
	{
		name: "memory_write",
		label: "写项目记忆",
		description:
			"写入项目记忆（<workspace>/.openpi/MEMORY.md），跨会话生效。用于沉淀：项目约定、技术决策及理由、用户偏好、踩坑提醒。mode=append 追加一条（默认，推荐一行一条精炼记录）；mode=replace 用 content 整体覆写（先 memory_read 确认全文）。不要记录敏感信息（密钥/密码）。",
		parameters: Type.Object({
			content: Type.String({ description: "要写入的记忆内容" }),
			mode: Type.Optional(Type.String({ description: "append（默认，追加）| replace（整体覆写）" })),
		}),
		execute(_id, params = {}) {
			const f = memoryFile();
			if (!f) return BAD("当前会话未绑定工作区，项目记忆不可用。");
			const content = String(params.content ?? "");
			if (!content.trim()) return BAD("记忆内容不能为空。");
			try {
				fs.mkdirSync(path.dirname(f), { recursive: true });
				if (params.mode === "replace") {
					fs.writeFileSync(f, content.trimEnd() + "\n");
				} else {
					fs.appendFileSync(f, content.trimEnd() + "\n");
				}
				return OK(`已写入项目记忆（${params.mode === "replace" ? "覆写" : "追加"}）：${f}`);
			} catch (err) {
				return BAD(`写入失败：${err.message}`);
			}
		},
	},
];
