// 复现用户场景：安装版 0.32.0 + 模糊提示"写个文档"（不带工作区）
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tabs = await CDP.List({ port: PORT });
const page = tabs.find((t) => t.type === "page");
const client = await CDP({ target: page.webSocketDebuggerUrl });
await client.Runtime.enable();
const ev = async (expr) => {
	const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.slice(0, 300));
	return r.result.value;
};
const waitSettled = async (timeout = 480000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const s = await ev(`({ streaming: state.streaming, has: !!state.session })`);
		if (s.has && !s.streaming) return true;
		await sleep(3000);
	}
	return false;
};

/* 不选工作区，直接开默认会话 */
await ev(`startSession().then(() => null)`);
await sleep(2000);
const cwdInfo = await ev(`state.session ? "session-ok" : "no-session"`);
console.log("会话:", cwdInfo);

await ev(`sendText("写个文档，主题是数字花园，内容随意", [])`);
const settled = await waitSettled();
console.log("settled:", settled);

/* 抓会话里的工具调用与 AI 最终答复 */
const dump = await ev(`(() => {
  const msgs = state.messages ?? [];
  const out = [];
  for (const m of msgs) {
    const role = m.role ?? "?";
    const txt = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    out.push("[" + role + "] " + txt.slice(0, 260));
  }
  return out.join("\\n---\\n").slice(0, 8000);
})()`);
console.log(dump);

/* 全盘找最近 10 分钟新建的 Office 文件 */
console.log("\n== 最近新建的 Office 文件搜索 ==");
const { execFileSync } = await import("node:child_process");
const roots = [os.homedir(), path.join(process.env.LOCALAPPDATA ?? "", "Programs", "openpi-desktop")];
const cutoff = Date.now() - 10 * 60 * 1000;
const exts = [".docx", ".pdf", ".pptx", ".xlsx"];
for (const root of roots) {
	try {
		const out = execFileSync("powershell", ["-NoProfile", "-Command",
			`Get-ChildItem -LiteralPath '${root.replace(/'/g, "''")}' -Recurse -File -EA SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-10) -and $_.Extension -match '^\\.(docx|pdf|pptx|xlsx)$' } | Select-Object -First 12 | ForEach-Object { $_.FullName + '  ' + $_.Length + 'B' }`],
			{ encoding: "utf8", timeout: 90000 });
		console.log(out.trim() || "(未找到)");
	} catch (e) {
		console.log("(搜索失败)", String(e.message).slice(0, 120));
	}
}
