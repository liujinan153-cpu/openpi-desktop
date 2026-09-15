// E2E P23：反撒谎验证 —— 真实记事本：聚焦(verified) → 粘贴(落点=targetPid) → 截图；假 pid → verified=false
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

const HOME = os.homedir();
const DAEMON = path.resolve("resources/computer-use/daemon.ps1");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. 关掉旧记事本，用显式路径起新的（PATH 里 Git 的假 notepad 会弹「打开方式」，不能用裸命令）
await exec("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from("Get-Process notepad -EA SilentlyContinue | Stop-Process -Force", "utf16le").toString("base64")]).catch(() => {});
await sleep(1500);
const { stdout: pidOut } = await exec("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from("$p = Start-Process C:\\Windows\\System32\\notepad.exe -PassThru; Start-Sleep 3; if (Get-Process -Id $p.Id -EA SilentlyContinue) { $p.Id } else { (Get-Process notepad | Select-Object -Last 1).Id }", "utf16le").toString("base64")]);
const npid = parseInt(pidOut.trim());
if (Number.isNaN(npid)) throw new Error("记事本启动失败");
console.log("记事本 pid:", npid);

// 2. 驱动 daemon（与扩展运行时同一条路径）
const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", DAEMON], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
proc.stdout.setEncoding("utf8");
let buf = "";
const results = [];
proc.stdout.on("data", (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i).trim();
		buf = buf.slice(i + 1);
		if (line.startsWith("@R@")) results.push(JSON.parse(line.slice(3)));
	}
});
proc.stderr.on("data", () => {});
const call = (op, params) => new Promise((res) => { const id = results.length + 1; proc.stdin.write(JSON.stringify({ id, op, ...params }) + "\n"); const t = setInterval(() => { const r = results.find((x) => x.id === id); if (r) { clearInterval(t); res(r); } }, 50); });
const wait = (id) => new Promise((res) => { const t = setInterval(() => { const r = results.find((x) => x.id === id); if (r) { clearInterval(t); res(r); } }, 50); setTimeout(() => { clearInterval(t); res(null); }, 20000); });

let rid = 0;
const ask = (op, params) => { const id = ++rid; proc.stdin.write(JSON.stringify({ id, op, ...params }) + "\n"); return wait(id); };

// 3. 先按 Esc 清掉可能存在的模态弹窗（如「打开方式」），再找记事本
await ask("key", { vks: [27] });
await sleep(600);
const wins = await ask("wins", {});
const found = (wins.data ?? []).find((w) => w.pid === npid);
console.log("wins 列表包含记事本:", !!found, found ? `「${found.title}」` : "");

// 4. focus → 必须 verified:true
const focus = await ask("focus", { pid: npid });
console.log("聚焦验证 verified:", focus.data.verified, "→", focus.data.name, "「" + focus.data.title + "」");

// 5. paste → 落点必须还是记事本
await sleep(300);
const paste = await ask("paste", { text: "123" });
console.log("粘贴落点:", JSON.stringify(paste.data), "→ targetPid === 记事本:", paste.data.targetPid === npid);

// 6. 截图（Agent 验证环节用的同一手段）——确认有图返回
const shot = await ask("shot", { path: path.join(os.tmpdir(), "p23.jpg"), maxw: 1600 });
const sz = fs.existsSync(path.join(os.tmpdir(), "p23.jpg")) ? fs.statSync(path.join(os.tmpdir(), "p23.jpg")).size : 0;
console.log("验证截图:", JSON.stringify(shot.data), `${sz} bytes`, sz > 20000 ? "✓" : "✗");

// 7. 反例：假 pid（System, 无窗口）→ verified 必须 false（扩展层会直接抛错拒绝输入）
const bad = await ask("focus", { pid: 4 });
console.log("假 pid 聚焦 verified:", bad.data.verified, bad.data.verified === false ? "✓（扩展层将报错拒输入）" : "✗");

// 8. 反例：不聚焦直接 paste → 落点暴露（此时前台可能是 OpenPi/终端，不是记事本）
const paste2 = await ask("paste", { text: "xx" });
console.log("盲粘贴落点:", paste2.data.target, paste2.data.targetPid === npid ? "（碰巧在记事本）" : `（不在记事本 → 扩展层提示 Agent 重新聚焦）`);

proc.kill();

// 9. 同步安装副本（用户已开启电脑控制）
const dest = path.join(HOME, ".pi/agent/extensions/computer-use");
fs.mkdirSync(dest, { recursive: true });
fs.copyFileSync("resources/computer-use/index.ts", path.join(dest, "index.ts"));
fs.copyFileSync("resources/computer-use/daemon.ps1", path.join(dest, "daemon.ps1"));
console.log("已同步安装副本:", fs.existsSync(path.join(dest, "daemon.ps1")));
console.log("== 完成（记事本未关闭，可目视确认有 123）==");
process.exit(0);
