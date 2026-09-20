/**
 * app-logger —— P71 主进程日志 + 一键导出日志包
 *
 * - initLogger(logDir)：向 logDir/main.log 追加写（行格式 `ISO时间 [level] message`），
 *   超 2MB 轮转为 main.old.log（覆盖旧轮转）；拦截替换 console.error/warn 双写文件
 *   （保留原控制台输出）；兜底捕获 uncaughtException / unhandledRejection。
 *   不 import electron，可在纯 node 环境单测。
 * - redactForExport(text)：导出前把 apiKey/api_key/token/secret/password 等
 *   JSON 字段值替换为 "***"（详见 unit-p71 断言验证，坑 #96：清洗正则必须打印验证）。
 * - collectLogBundle({ piAgentDir, appInfo })：内存拼装导出清单（不落盘）：
 *   main.log / main.old.log（存在才含）/ computer-audit.log（存在才含）/
 *   settings.json（脱敏后）/ info.txt（环境信息）。
 *   绝不包含 auth.json 和 sessions 目录。
 */
import fs from "node:fs";
import path from "node:path";

const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2MB 触发轮转
const LOG_NAME = "main.log";
const OLD_NAME = "main.old.log";

let state = null; // { logDir, file }
let consolePatched = false; // 多次 initLogger 只挂一次拦截，避免重复双写

/** 参数序列化：字符串原样、Error 取 stack、其余安全 JSON 化 */
function fmtArg(a) {
	if (typeof a === "string") return a;
	if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
	try { return JSON.stringify(a); } catch { return String(a); }
}

/** 超 2MB 轮转：main.log → main.old.log（覆盖旧轮转），再清空 main.log */
function rotateIfNeeded() {
	const st = state;
	if (!st) return;
	let size = 0;
	try { size = fs.statSync(st.file).size; } catch { return; }
	if (size < MAX_LOG_BYTES) return;
	try {
		fs.copyFileSync(st.file, path.join(st.logDir, OLD_NAME)); // copyFileSync 默认覆盖
		fs.truncateSync(st.file, 0);
	} catch { /* 轮转失败不阻断主流程 */ }
}

function appendLine(level, args) {
	const st = state;
	if (!st) return;
	try {
		rotateIfNeeded();
		const msg = args.map(fmtArg).join(" ").replace(/\r?\n/g, " ");
		fs.appendFileSync(st.file, `${new Date().toISOString()} [${level}] ${msg}\n`);
	} catch { /* 日志失败不阻断 */ }
}

/**
 * 初始化日志：创建 logDir，返回 { log, error, warn }；
 * 并拦截 console.error/warn 落文件 + 捕获进程级未处理异常。
 */
export function initLogger(logDir) {
	fs.mkdirSync(logDir, { recursive: true });
	state = { logDir, file: path.join(logDir, LOG_NAME) };

	if (!consolePatched) {
		consolePatched = true;
		const origError = console.error.bind(console);
		const origWarn = console.warn.bind(console);
		console.error = (...args) => { origError(...args); appendLine("error", args); };
		console.warn = (...args) => { origWarn(...args); appendLine("warn", args); };
		process.on("uncaughtException", (err) => appendLine("fatal", ["uncaughtException:", err]));
		process.on("unhandledRejection", (reason) => appendLine("error", ["unhandledRejection:", reason]));
	}

	return {
		log: (...args) => appendLine("info", args),
		warn: (...args) => appendLine("warn", args),
		error: (...args) => appendLine("error", args),
	};
}

/* 敏感字段名（小写比对，含常见别名） */
const REDACT_RE = new RegExp(
	`("(?:api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|secret|secret[_-]?key|password|passwd|pwd)"\\s*:\\s*")(?:[^"\\\\]|\\\\.)*(")`,
	"gi",
);

/**
 * 导出脱敏：把 JSON 里 apiKey/api_key/token/secret/password 等字段的字符串值替换为 "***"。
 * 只匹配「带双引号的 JSON 键值对」，普通文本里出现这些词不受影响。
 */
export function redactForExport(text) {
	return String(text ?? "").replace(REDACT_RE, "$1***$2");
}

/** 尽力读取文件，不存在返回 null */
function readOrNull(p) {
	try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

/**
 * 收集日志包清单（内存中拼好，不落盘）。
 * 返回 [{ name, content }, ...]；绝不包含 auth.json 和 sessions 目录。
 */
export function collectLogBundle({ piAgentDir, appInfo = {} } = {}) {
	if (!piAgentDir) throw new Error("collectLogBundle 需要 piAgentDir");
	const files = [];
	// 日志正文同样过脱敏：console.error 可能带 config dump / SDK 报错里的密钥字面量（审查缺陷 #3）
	const mainLog = readOrNull(path.join(piAgentDir, "logs", LOG_NAME));
	if (mainLog !== null) files.push({ name: LOG_NAME, content: redactForExport(mainLog) });
	const oldLog = readOrNull(path.join(piAgentDir, "logs", OLD_NAME));
	if (oldLog !== null) files.push({ name: OLD_NAME, content: redactForExport(oldLog) });
	const audit = readOrNull(path.join(piAgentDir, "computer-audit.log"));
	if (audit !== null) files.push({ name: "computer-audit.log", content: redactForExport(audit) });
	// settings.json：脱敏后收录（密钥字段打码）；auth.json / sessions 一律不进包
	const settings = readOrNull(path.join(piAgentDir, "settings.json"));
	if (settings !== null) files.push({ name: "settings.json", content: redactForExport(settings) });
	const info = [
		"OpenPi Desktop 日志包信息（info.txt）",
		`导出时间: ${new Date().toISOString()}`,
		`应用版本: ${appInfo.version ?? "unknown"}`,
		`Electron: ${appInfo.electron ?? process.versions.electron ?? "unknown"}`,
		`Node: ${appInfo.node ?? process.versions.node ?? "unknown"}`,
		`平台: ${appInfo.platform ?? process.platform}`,
		"",
	].join("\n");
	files.push({ name: "info.txt", content: info });
	return files;
}
