// E2E P20：技能管理 + 电脑控制
// 前置：electron --remote-debugging-port=9333 已启动
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();
const WS = path.join(HOME, "openpi-workspace");
const CU_FILE = path.join(HOME, ".pi", "agent", "extensions", "computer-use", "index.ts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (client, name) => {
	const r = await client.Page.captureScreenshot({ format: "png", fromSurface: true });
	fs.writeFileSync(`p20-${name}.png`, Buffer.from(r.data, "base64"));
	console.log(`📸 p20-${name}.png`);
};

// 清理上次残留
for (const p of [path.join(HOME, ".pi/agent/skills/e2e-test-skill"), path.join(HOME, ".pi/agent/skills-disabled/e2e-test-skill")]) {
	fs.rmSync(p, { recursive: true, force: true });
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

console.log("== 1. 设置页：技能与能力 tab ==");
await ev(`openSettings()`);
await sleep(400);
await ev(`document.querySelector('.tab[data-tab="skills"]').click()`);
await sleep(600);
console.log("cu-toggle 状态(默认关):", await ev(`!document.getElementById("cu-toggle").checked`));
console.log("外部来源技能已列出:", await ev(`[...document.querySelectorAll(".skill-group")].some(g=>g.textContent.startsWith("外部来源"))`));

console.log("== 2. 新建技能 ==");
await ev(`document.getElementById("btn-skill-new").click()`);
await ev(`(function(){document.getElementById("skill-new-name").value="e2e-test-skill";document.getElementById("skill-new-desc").value="E2E 测试技能：验证创建/启停/删除";document.getElementById("btn-skill-create").click()})()`);
await sleep(600);
console.log("出现在已安装:", await ev(`[...document.querySelectorAll(".skill-group")].some(g=>g.textContent.startsWith("已安装")) && [...document.querySelectorAll(".skill-item b")].some(b=>b.textContent==="e2e-test-skill")`));
console.log("SKILL.md 落盘:", fs.existsSync(path.join(HOME, ".pi/agent/skills/e2e-test-skill/SKILL.md")));

console.log("== 3. 启停 ==");
await ev(`document.querySelector(".skill-item .switch input").click()`);
await sleep(600);
console.log("关闭后进入已停用组:", await ev(`[...document.querySelectorAll(".skill-group")].map(g=>g.textContent).join("|")`));
console.log("目录已移动:", fs.existsSync(path.join(HOME, ".pi/agent/skills-disabled/e2e-test-skill")) && !fs.existsSync(path.join(HOME, ".pi/agent/skills/e2e-test-skill")));
await ev(`document.querySelector(".skill-item .switch input").click()`);
await sleep(600);
console.log("重新开启:", fs.existsSync(path.join(HOME, ".pi/agent/skills/e2e-test-skill")));

console.log("== 4. 搜索过滤 ==");
await ev(`(function(){const i=document.getElementById("skill-search"); i.value="e2e-test"; i.dispatchEvent(new Event("input"))})()`);
await sleep(300);
console.log("过滤后条数=1:", await ev(`document.querySelectorAll(".skill-item").length===1`));
await ev(`(function(){const i=document.getElementById("skill-search"); i.value=""; i.dispatchEvent(new Event("input"))})()`);

console.log("== 5. 电脑控制开关 ==");
await ev(`document.getElementById("cu-toggle").click()`);
await sleep(600);
console.log("扩展已安装到 pi 全局目录:", fs.existsSync(CU_FILE));
console.log("状态文案:", await ev(`document.getElementById("cu-status").textContent.slice(0,12)`));

console.log("== 6. pi 真实加载扩展（新会话工具列表） ==");
await ev(`startSession(${JSON.stringify(WS)})`);
await sleep(4000);
const tools = await ev(`window.openpi.agentTools()`);
console.log("computer_* 工具数:", tools.filter((t) => t.startsWith("computer_")).length, "| 全部:", tools.filter((t) => t.startsWith("computer_")).join(", "));
console.log("工具注册成功:", ["computer_screenshot", "computer_click", "computer_type", "computer_key", "computer_scroll", "computer_windows", "computer_wait"].every((t) => tools.includes(t)));

console.log("== 7. 截图管线真实验证（独立跑同款 PowerShell） ==");
const psScript = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object Drawing.Bitmap $b.Width, $b.Height
$g = [Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save("${path.join(WS, "p20-shot.png").replace(/\\/g, "\\\\")}", [Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $cuResult = "ok"`;
execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(psScript, "utf16le").toString("base64")], { timeout: 30000 });
const shotFile = path.join(WS, "p20-shot.png");
const png = fs.readFileSync(shotFile);
console.log("截图文件:", png.length, "bytes | PNG 头正确:", png.slice(0, 8).toString("hex") === "89504e470d0a1a0a");
fs.rmSync(shotFile, { force: true });

console.log("== 8. 鼠标/窗口工具冒烟（与扩展同款 here-string + $cuResult 流程） ==");
const smoke = `Add-Type @"
using System;using System.Runtime.InteropServices;
public class CUInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
}
"@
[CUInput]::SetCursorPos(100,100)
$cuResult = "mouse moved ok"
`;
execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(smoke, "utf16le").toString("base64")], { timeout: 20000 });
console.log("SetCursorPos 冒烟: ok");
await shot(client, "skills-page");

console.log("== 清理 ==");
// 删除测试技能（走 UI 逻辑同款 IPC）
await ev(`window.openpi.skillsDelete("e2e-test-skill")`);
// 关闭电脑控制
await ev(`window.openpi.computerUseSet(false)`);
await sleep(400);
console.log("扩展已移除:", !fs.existsSync(CU_FILE));
console.log("== 完成 ==");
process.exit(0);
