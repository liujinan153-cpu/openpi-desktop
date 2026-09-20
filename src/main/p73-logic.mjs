/**
 * P73 纯逻辑层 —— 子智能体管理（设置页 + agent-host 派发共用）
 *
 * 只放无副作用/无 Node 专属依赖的纯函数（fs/IPC 一律放调用方）：
 *  - BUILTIN_SUBAGENT_META：内置角色的设置页展示元数据（中文描述；工具白名单与
 *    agent-host.mjs 的 WORKER_ROLES.extraTools 对齐——那份常量是运行时唯一权威）
 *  - sanitizeSubagentFilename：自定义角色 name → 安全文件名（Windows 非法字符清洗）
 *  - parseSubagentJsonFile：~/.pi/agent/subagents/*.json 单文件解析与校验（坏文件返回 null 跳过）
 *  - resolveWorkerRole：派发时角色校验 + 禁用清单回退（被禁用回退 explore 并注明）
 */

/** 内置四角色（P64）的设置页展示元数据；extraTools 与 agent-host.mjs WORKER_ROLES 保持一致 */
export const BUILTIN_SUBAGENT_META = [
	{ id: "explore", name: "探索", desc: "只读调研：不改任何东西，输出发现与证据（文件路径+关键行）", tools: [] },
	{ id: "coder", name: "写码", desc: "专注改码，改完自证；bash 只跑构建/测试类命令", tools: ["write", "edit", "run_cmd"] },
	{ id: "tester", name: "测试", desc: "只负责跑测试/验证并输出通过/失败证据，不修代码", tools: ["run_cmd"] },
	{ id: "reviewer", name: "审查", desc: "对抗式审查：找 bug、边界情况、安全风险，输出问题清单，不改代码", tools: [] },
];

/** Windows 文件名非法字符 + 控制字符 → 替换为 -；首尾空白/点去掉（Windows 尾点是坑）；空名回退 */
export function sanitizeSubagentFilename(name) {
	let s = String(name ?? "")
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
		.trim()
		.replace(/^[.\s]+|[.\s]+$/g, ""); // Windows：文件名不能以点/空格结尾
	s = s.slice(0, 60);
	// 审查修复：Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）在 Win32 路径解析会命中设备，加前缀规避
	if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(s)) s = `_${s}`;
	return s || "subagent";
}

/**
 * 解析单个自定义角色 JSON 文件。
 * 合法结构：{ name, desc?, tools?, prefix? }（name 必填非空）；返回规范化的 { id, name, desc, tools, prefix }，
 * 任何不合法（坏 JSON / 缺 name / 非对象 / tools 非数组）→ 返回 null，调用方跳过该文件。
 * @param {string} fileName 文件名（id 取去除 .json 后缀的部分）
 * @param {string} raw 文件内容
 */
export function parseSubagentJsonFile(fileName, raw) {
	const id = String(fileName ?? "").replace(/\.json$/i, "").trim();
	if (!id) return null;
	let obj;
	try { obj = JSON.parse(String(raw ?? "")); } catch { return null; }
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
	const name = typeof obj.name === "string" ? obj.name.trim() : "";
	if (!name) return null;
	const desc = typeof obj.desc === "string" ? obj.desc.trim() : "";
	const tools = Array.isArray(obj.tools) ? obj.tools.map((t) => String(t).trim()).filter(Boolean) : [];
	const prefix = typeof obj.prefix === "string" ? obj.prefix : "";
	return { id, name, desc, tools, prefix };
}

/**
 * 派发时角色校验：未知角色 → explore；被禁用角色 → 回退 explore 并注明。
 * @param {string|undefined} role 请求的角色
 * @param {string[]} builtinIds 内置角色 id（agent-host WORKER_ROLES 的 keys）
 * @param {{id:string}[]} customs 自定义角色定义（已 parse 过）
 * @param {string[]} disabledIds 禁用清单（openpi-settings.json 的 disabledSubagents）
 * @returns {{role:string, note:string, custom:object|null}} custom 非 null 表示角色定义来自自定义 JSON
 */
export function resolveWorkerRole(role, builtinIds, customs, disabledIds) {
	const builtin = Array.isArray(builtinIds) ? builtinIds : [];
	const customList = Array.isArray(customs) ? customs : [];
	const disabled = Array.isArray(disabledIds) ? disabledIds.map(String) : [];
	let r = builtin.includes(role) || customList.some((c) => c.id === role) ? role : "explore";
	let note = "";
	if (disabled.includes(r)) {
		note = r === "explore"
			? "explore 已被禁用，仍以 explore 只读基座兜底"
			: `${r} 该角色已被禁用，已回退 explore`;
		r = "explore";
	}
	const custom = customList.find((c) => c.id === r) ?? null;
	return { role: r, note, custom };
}
