/**
 * P56 OS 级 computer-use：让 AI 能看屏幕、动鼠标键盘、操作本地应用。
 * - 底层：PowerShell + user32 P/Invoke（computer-ops.ps1），零新增 npm 依赖
 * - 工具：list_windows / screenshot（只读直通）+ click / type / key / activate（写类走通用审批）
 * - 安全：全部调用落审计日志（~/.pi/agent/computer-audit.log）；子代理不带本组工具
 */
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PS1 = (() => {
	try {
		const packed = join(process.resourcesPath ?? "", "computer-ops.ps1"); // 打包态：extraResources 落在 asar 外，powershell 才读得到
		if (packed && existsSync(packed)) return packed;
	} catch { /* 普通 node 环境 */ }
	return join(dirname(fileURLToPath(import.meta.url)), "computer-ops.ps1"); // dev 态：源码路径
})();
const OKR = (text) => ({ content: [{ type: "text", text }], details: { ok: true } });
const BADR = (text) => ({ content: [{ type: "text", text }], details: { ok: false } });

/** 审计日志（谁在何时动了电脑，全量落盘） */
function audit(op, args) {
	try {
		const dir = join(homedir(), ".pi", "agent");
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "computer-audit.log"), `${new Date().toISOString()} ${op} ${JSON.stringify(args).slice(0, 200)}\n`);
	} catch { /* 日志失败不阻断 */ }
}

function runPs(op, args = []) {
	return new Promise((resolve) => {
		audit("computer_" + op, args);
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", PS1, op, ...args.map(String)],
			{ timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
			(err, stdout) => {
				const out = String(stdout ?? "").trim();
				if (err && !out.startsWith("OK")) return resolve({ ok: false, err: (out || err.message).slice(0, 400) });
				if (out.startsWith("ERR")) return resolve({ ok: false, err: out.slice(3).trim() });
				resolve({ ok: out.startsWith("OK"), data: out.slice(2).trim() });
			},
		);
	});
}

export const computerTools = [
	{
		name: "computer_list_windows",
		label: "列出窗口",
		description: "列出当前所有有主窗口的进程（pid / 进程名 / 窗口标题）。操作窗口前先用它定位目标。",
		parameters: Type.Object({}),
		async execute() {
			const r = await runPs("list_windows");
			return r.ok ? OKR(`窗口列表：\n${r.data}`) : BADR(`list_windows 失败：${r.err}`);
		},
	},
	{
		name: "computer_screenshot",
		label: "截取屏幕",
		description:
			"截取全屏（多显示器合并虚拟屏）保存为 PNG，返回文件路径——再用 read 工具读取该图片即可看到画面。点击/输入前先截图，操作后也截图验证。",
		parameters: Type.Object({
			out: Type.Optional(Type.String({ description: "PNG 保存路径，默认临时目录 computer-<时间戳>.png" })),
		}),
		async execute(_id, params = {}) {
			const out = params.out || join(tmpdir(), `computer-${Date.now()}.png`);
			const r = await runPs("screenshot", [out]);
			if (!r.ok) return BADR(`screenshot 失败：${r.err}`);
			const size = existsSync(out) ? statSync(out).size : 0;
			return OKR(`已截图：${out}（${Math.round(size / 1024)}KB）。用 read 工具读取该路径查看画面。`);
		},
	},
	{
		name: "computer_click",
		label: "点击屏幕",
		description: "移动鼠标到屏幕坐标 (x, y) 并点击。button: left（默认）/ right / middle 无效时用 left；double=true 双击。坐标从截图（虚拟屏坐标系）读取。",
		parameters: Type.Object({
			x: Type.Number({ description: "屏幕 X 坐标" }),
			y: Type.Number({ description: "屏幕 Y 坐标" }),
			button: Type.Optional(Type.String({ description: "left（默认）/ right / double" })),
		}),
		async execute(_id, params = {}) {
			const r = await runPs("click", [params.x, params.y, params.button ?? "left"]);
			return r.ok ? OKR(r.data) : BADR(`click 失败：${r.err}`);
		},
	},
	{
		name: "computer_type",
		label: "输入文字",
		description: "向当前焦点窗口输入任意文字（含中文，走剪贴板粘贴，会覆盖剪贴板原内容）。输入前必须先点击目标输入框获得焦点，输入后截图验证文字真的出现。",
		parameters: Type.Object({
			text: Type.String({ description: "要输入的文字" }),
		}),
		async execute(_id, params = {}) {
			const r = await runPs("type", [String(params.text ?? "")]);
			return r.ok ? OKR(r.data) : BADR(`type 失败：${r.err}`);
		},
	},
	{
		name: "computer_key",
		label: "发送按键",
		description: "向当前焦点窗口发送按键：enter / esc / tab / backspace / delete / home / end / pgup / pgdn / up / down / left / right / space / win，或单个字符。",
		parameters: Type.Object({
			key: Type.String({ description: "按键名，如 enter、esc" }),
		}),
		async execute(_id, params = {}) {
			const r = await runPs("key", [String(params.key ?? "")]);
			return r.ok ? OKR(r.data) : BADR(`key 失败：${r.err}`);
		},
	},
	{
		name: "computer_activate",
		label: "激活窗口",
		description: "把指定 pid 的窗口切到前台并聚焦（输入/按键前先激活）。pid 从 computer_list_windows 获取。",
		parameters: Type.Object({
			pid: Type.Number({ description: "目标进程 pid" }),
		}),
		async execute(_id, params = {}) {
			const r = await runPs("activate", [params.pid]);
			return r.ok ? OKR(r.data) : BADR(`activate 失败：${r.err}`);
		},
	},
];
