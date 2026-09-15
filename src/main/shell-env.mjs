/**
 * Shell 环境修复（P40.2，向 pi Desktop 取经）：
 * GUI 启动的 Electron 可能拿不到最新的用户级 PATH（装完 Node/Python/Git 后未注销重登、
 * 或从非 Explorer 入口启动）。启动时把 HKCU\Environment 的 PATH + 常见工具目录合并进
 * process.env.PATH，避免 agent 调 bash 报 "command not found"。
 * 原则：尽力而为，任何失败不阻断启动（console 记录即可）。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** 常见工具目录（存在才合并） */
function commonDirs() {
	const u = os.homedir();
	return [
		path.join(u, "AppData", "Roaming", "npm"), // npm 全局 bin
		path.join(u, "scoop", "shims"),
		path.join(u, ".cargo", "bin"),
		path.join(u, "go", "bin"),
		path.join(u, ".local", "bin"),
	];
}

/** 读注册表用户 PATH（PowerShell 一行，最稳；reg query 输出编码在 GBK 控制台不可靠） */
function readUserPath() {
	return new Promise((resolve) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", "(Get-ItemProperty -Path 'HKCU:\\Environment' -Name Path -ErrorAction SilentlyContinue).Path"],
			{ timeout: 8000, windowsHide: true },
			(err, stdout) => resolve(err ? "" : String(stdout ?? "").trim()),
		);
	});
}

const SEP = path.delimiter;
const norm = (p) => p.trim().replace(/^["']|["']$/g, "");

export async function ensureShellEnv() {
	if (process.env.OPENPI_ENV_READY) return 0;
	try {
		const userPath = await readUserPath();
		const have = new Set(process.env.PATH.split(SEP).map(norm).filter(Boolean).map((p) => p.toLowerCase()));
		const extra = [];
		const push = (p) => {
			const n = norm(p);
			if (!n || have.has(n.toLowerCase())) return;
			if (!fs.existsSync(n)) return; // 不存在的目录不塞，保持 PATH 干净
			have.add(n.toLowerCase());
			extra.push(n);
		};
		for (const d of userPath.split(SEP)) push(d);
		for (const d of commonDirs()) push(d);
		if (extra.length) {
			// 尾部追加而非前插：不抢已有条目的优先级（内置 Python 运行时必须保持第一），只兑底「找不到的命令」
			process.env.PATH = [process.env.PATH, ...extra].filter(Boolean).join(SEP);
			console.error(`[shell-env] PATH 尾部补齐 ${extra.length} 项: ${extra.map((p) => path.basename(p)).join(", ")}`);
		} else {
			console.error("[shell-env] PATH 已完整，无需补齐");
		}
		process.env.OPENPI_ENV_READY = "1";
		return extra.length;
	} catch (err) {
		console.error(`[shell-env] 失败（不阻断启动）: ${err.message ?? err}`);
		return 0;
	}
}
