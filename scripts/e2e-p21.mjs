// E2E P21：tab 拆分 + 电脑控制重写（常驻daemon）+ 技能 GitHub 安装
// 前置：electron --remote-debugging-port=9333 已启动
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const HOME = os.homedir();
const WS = path.join(HOME, "openpi-workspace");
const CU_DIR = path.join(HOME, ".pi", "agent", "extensions", "computer-use");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (client, name) => {
	const r = await client.Page.captureScreenshot({ format: "png", fromSurface: true });
	fs.writeFileSync(`p21-${name}.png`, Buffer.from(r.data, "base64"));
	console.log(`📸 p21-${name}.png`);
};

// 清理上次残留
await (async () => {})();
for (const d of ["e2e-test-skill", "brave-search", "browser-tools", "transcribe"]) {
	fs.rmSync(path.join(HOME, ".pi/agent/skills", d), { recursive: true, force: true });
	fs.rmSync(path.join(HOME, ".pi/agent/skills-disabled", d), { recursive: true, force: true });
}

const client = await (async () => {
	const tabs = await CDP.List({ port: 9333 });
	const page = tabs.find((t) => t.type === "page");
	return CDP({ target: page.webSocketDebuggerUrl });
})();
await client.Runtime.enable();
await client.Page.enable();
const ev = async (expr) => {
	const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.slice(0, 400));
	return r.result.value;
};

console.log("== 1. tab 拆分 ==");
await ev(`openSettings()`);
await sleep(400);
await ev(`document.querySelector('.tab[data-tab="computer"]').click()`);
await sleep(300);
console.log("电脑控制独立tab:", await ev(`!document.getElementById("tab-computer").hidden && !!document.getElementById("cu-toggle")`));
console.log("工具清单展示:", await ev(`document.querySelectorAll(".cu-tools span").length >= 9`));
await ev(`document.querySelector('.tab[data-tab="skills"]').click()`);
await sleep(500);
console.log("技能tab独立:", await ev(`!document.getElementById("tab-skills").hidden && !!document.getElementById("btn-skill-install")`));
await shot(client, "tabs");

console.log("== 2. 技能 GitHub 真实安装 ==");
const t0 = Date.now();
console.log(
	await ev(`window.openpi.skillsInstall("https://github.com/badlogic/pi-skills").then(r=>JSON.stringify(r)).catch(e=>"ERR: "+e.message)`),
	`(${Date.now() - t0}ms)`,
);
await sleep(300);
console.log("新技能出现在已安装组:", await ev(`renderSkillsPage().then(()=>[...document.querySelectorAll(".skill-item b")].some(b=>b.textContent==="brave-search"))`));
console.log("落盘验证:", fs.existsSync(path.join(HOME, ".pi/agent/skills/brave-search/SKILL.md")));
await shot(client, "installed");

console.log("== 3. 电脑控制开启 → 新会话工具注册 ==");
await ev(`window.openpi.computerUseSet(false)`); // 归零，避免上次残留导致 click 变成关闭
await ev(`renderSkillsPage()`);
await sleep(300);
await ev(`document.querySelector('.tab[data-tab="computer"]').click()`);
await sleep(300);
await ev(`document.getElementById("cu-toggle").click()`);
await sleep(600);
console.log("扩展安装（含 daemon.ps1）:", fs.existsSync(path.join(CU_DIR, "index.ts")) && fs.existsSync(path.join(CU_DIR, "daemon.ps1")));
await ev(`startSession(${JSON.stringify(WS)})`);
await sleep(4000);
const tools = await ev(`window.openpi.agentTools()`);
const cu = tools.filter((t) => t.startsWith("computer_"));
console.log("computer_* 工具数:", cu.length, "→", cu.join(", "));
console.log("新工具齐全(drag/focus/clipboard):", ["computer_drag", "computer_focus", "computer_clipboard"].every((t) => cu.includes(t)));

console.log("== 4. daemon 性能（直接驱动同款脚本） ==");
const { default: CDP_ } = { default: null }; // 占位，保持 import 一致性
const perf = await (async () => {
	const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", path.join(CU_DIR, "daemon.ps1")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
	proc.stdout.setEncoding("utf8");
	let buf = "";
	const results = [];
	proc.stdout.on("data", (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i).trim();
			buf = buf.slice(i + 1);
			if (line.startsWith("@R@")) results.push(line.slice(3));
		}
	});
	const t = Date.now();
	proc.stdin.write(JSON.stringify({ id: 1, op: "shot", path: path.join(os.tmpdir(), "p21.jpg"), maxw: 1600 }) + "\n");
	await sleep(2500);
	const dt = Date.now() - t;
	const ok = results.length === 1 && JSON.parse(results[0]).ok;
	proc.kill();
	return { dt, ok, size: fs.existsSync(path.join(os.tmpdir(), "p21.jpg")) ? fs.statSync(path.join(os.tmpdir(), "p21.jpg")).size : 0 };
})();
console.log("daemon 截图:", JSON.stringify(perf), perf.ok && perf.size > 30000 ? "✓" : "✗");

console.log("== 清理 ==");
await ev(`window.openpi.computerUseSet(false)`);
console.log("扩展已移除:", !fs.existsSync(CU_DIR));
for (const d of fs.readdirSync(path.join(HOME, ".pi/agent/skills"))) {
	if (["brave-search", "browser-tools", "gccli", "gdcli", "gmcli", "transcribe", "vscode", "youtube-transcript", "e2e-test-skill"].includes(d)) {
		fs.rmSync(path.join(HOME, ".pi/agent/skills", d), { recursive: true, force: true });
	}
}
console.log("测试安装的技能已清理");
console.log("== 完成 ==");
process.exit(0);
