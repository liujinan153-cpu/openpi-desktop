/**
 * P76 纯逻辑层 —— 子智能体动作流水（agent-host worker 订阅 → 渲染层「子智能体」dock 页）
 *
 * 只放无副作用/无 IO 的纯函数：workerActivityFromEvent(e) 把 SDK worker 会话的
 * tool_execution_start / tool_execution_end 事件映射为转发给渲染层的动作摘要：
 *  - start → { kind:"tool", toolCallId, title, detail }
 *  - end   → { kind:"tool_end", toolCallId, ok }（ms 由调用方按 start 时刻补）
 *  - 其余事件 → null（不转发）
 * 标题语义与渲染层 toolTitle（app.js P75）同族：编辑/运行/读取/搜索/工具名兜底。
 */

/** 提取路径 basename（兼容 \ 与 /，去尾部分隔符；空入参返回 ""） */
export function basename(p) {
	const s = String(p ?? "").replace(/[\\/]+$/, "");
	if (!s) return "";
	const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
	return i >= 0 ? s.slice(i + 1) : s;
}

/** 摘要截断：压平换行为空格后取前 n 字；空值返回 "" */
export function clip(s, n) {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	return t.slice(0, n);
}

/** 工具分类判断（与 app.js toolMergeCat 同族）：编辑类 / 运行类 / 搜索类 */
const isEditTool = (n) => n === "edit" || n === "write" || n === "apply_patch";
const isRunTool = (n) => n === "bash" || n === "powershell" || n === "run_cmd" || n === "run" || n === "cmd";
const isSearchTool = (n) => /^(grep|find|ls|search|glob|rg|code_search|list)$/.test(n) || /^(grep|search|find)_/.test(n);

/**
 * worker 会话事件 → 动作摘要。
 * @param {{type?:string, toolCallId?:string, toolName?:string, args?:any, isError?:boolean}|null|undefined} e
 * @returns {{kind:"tool", toolCallId:string, title:string, detail:string}|{kind:"tool_end", toolCallId:string, ok:boolean}|null}
 */
export function workerActivityFromEvent(e) {
	if (!e || typeof e !== "object") return null;
	if (e.type === "tool_execution_end") {
		const tcid = String(e.toolCallId ?? "");
		if (!tcid) return null;
		return { kind: "tool_end", toolCallId: tcid, ok: !e.isError };
	}
	if (e.type !== "tool_execution_start") return null;
	const name = String(e.toolName ?? "").trim();
	if (!name) return null;
	const args = typeof e.args === "string" ? { command: e.args } : e.args && typeof e.args === "object" ? e.args : {};
	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
	let title;
	let detail;
	if (isEditTool(name)) {
		const base = basename(path);
		title = base ? `编辑 ${clip(base, 60)}` : name;
		detail = clip(path, 120); // 全路径进 detail（标题已有 basename）
	} else if (isRunTool(name)) {
		const cmd = clip(args.command ?? args.cmd ?? args.script ?? "", 120);
		title = cmd ? `运行 ${clip(cmd, 60)}` : name;
		detail = cmd;
	} else if (name === "read") {
		const base = basename(path);
		title = base ? `读取 ${clip(base, 60)}` : name;
		detail = clip([path && base !== path ? path : "", args.offset != null ? `L${args.offset}~` : ""].filter(Boolean).join(" "), 120);
	} else if (isSearchTool(name)) {
		const pat = clip(args.pattern ?? args.query ?? args.search ?? args.glob ?? basename(args.path), 120);
		title = pat ? `搜索 ${clip(pat, 40)}` : name;
		detail = pat;
	} else {
		title = name; // 未知工具兜底：直接用工具名
		detail = clip(args.pattern ?? args.query ?? path ?? "", 120);
	}
	return { kind: "tool", toolCallId: String(e.toolCallId ?? ""), title: clip(title, 120), detail };
}
