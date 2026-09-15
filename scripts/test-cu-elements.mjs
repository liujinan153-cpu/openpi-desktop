/**
 * 桌面控制精准化 E2E（daemon 直连，不起 Electron）：
 * 真实记事本全链路：启动 → 聚焦(焦点控件) → UIA 元素枚举 → 按元素坐标点击落点 → 粘贴(焦点控件) → 区域截图
 * 注意：显式 System32 notepad 路径（踩坑 #37：PATH 里 Git 的假 notepad）
 */
import { spawn, execSync } from "node:child_process";
import { unlinkSync, existsSync } from "node:fs";

const PROOF = "cu-elements-proof.jpg";
if (existsSync(PROOF)) unlinkSync(PROOF);

const proc = spawn(
	"powershell.exe",
	["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", "resources/computer-use/daemon.ps1"],
	{ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
);
let buf = "";
const pending = new Map();
let seq = 0;
proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i).trim();
		buf = buf.slice(i + 1);
		if (!line.startsWith("@R@")) continue;
		try {
			const r = JSON.parse(line.slice(3));
			const p = pending.get(r.id);
			if (p) {
				pending.delete(r.id);
				clearTimeout(p.timer);
				r.ok ? p.res(r.data) : p.rej(new Error(String(r.data)));
			}
		} catch { /* 忽略坏行 */ }
	}
});
proc.stderr.on("data", () => {});
proc.on("exit", () => {
	for (const p of pending.values()) { clearTimeout(p.timer); p.rej(new Error("daemon 退出")); }
	pending.clear();
});

function call(op, params = {}, timeout = 25000) {
	const id = ++seq;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${op} 超时`)); }, timeout);
		pending.set(id, { res: resolve, rej: reject, timer });
		proc.stdin.write(JSON.stringify({ id, op, ...params }) + "\n");
	});
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let notepadPid = null;
const fails = [];
const ok = (name, cond, extra = "") => {
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails.push(name);
};

try {
	// 1. 启动真实记事本（显式路径）
	const np = spawn("C:\\Windows\\System32\\notepad.exe", [], { detached: true, stdio: "ignore" }).unref();
	await sleep(1800);
	const wins = await call("wins");
	const target = wins.find((w) => /notepad/i.test(w.name));
	ok("wins 找到记事本", !!target, target ? `pid=${target.pid}` : "");
	if (!target) throw new Error("记事本未启动");
	notepadPid = target.pid;

	// 2. 聚焦并验证 + 焦点控件回传
	const f = await call("focus", { pid: notepadPid });
	ok("focus verified", f.verified === true, `fgPid=${f.fgPid}`);
	ok("focus 回传焦点控件", !!f.feType, `${f.feType}「${f.feName}」`);

	// 3. UIA 元素枚举（新能力核心）
	const els = await call("elements", { pid: notepadPid }, 30000);
	ok("elements 返回窗口信息", !!els.window?.type, `${els.window?.type}「${els.window?.name}」 total=${els.total}`);
	ok("elements 枚举到元素", els.count > 0, `count=${els.count}`);
	const editable = (els.elements ?? []).find((e) => ["Edit", "Document"].includes(e.type));
	ok("枚举到可输入控件（Edit/Document）", !!editable, editable ? `#${editable.i}「${editable.name}」 @(${editable.x},${editable.y}) ${editable.w}x${editable.h}` : "");
	console.log("--- 元素样例 ---");
	for (const e of (els.elements ?? []).slice(0, 12)) console.log(`#${e.i} ${e.type}「${e.name}」 @ (${e.x},${e.y}) ${e.w}x${e.h}`);
	if (!editable) throw new Error("未枚举到可输入控件");

	// 4. 点击可输入控件中心 → 落点应报告控件级信息
	const click = await call("click", { x: editable.x, y: editable.y });
	ok("click 落点=记事本", click.targetPid === notepadPid, `target=${click.target}`);
	ok("click 控件级落点", !!click.elType, `${click.elType}「${click.elName}」`);

	// 5. 粘贴（焦点控件回传 = 反撒谎：文字进了哪个控件）
	const paste = await call("paste", { text: "精准测试 openpi-elements-OK-123" });
	ok("paste 落点=记事本", paste.targetPid === notepadPid, `target=${paste.target}`);
	ok("paste 焦点控件回传", !!paste.feType, `${paste.feType}「${paste.feName}」`);
	await sleep(400);

	// 5.5 程序化回读：焦点控件文本应包含标记（比截图更硬的验证）
	const read = await call("readfocus", {});
	ok("readfocus 回读含标记文本", String(read.text ?? "").includes("openpi-elements-OK-123"), `${read.type}「${read.name}」= ${String(read.text).slice(0, 60)}`);
	await sleep(200);

	// 6. 区域截图（可输入控件附近）→ 人工/视觉验证文字真出现了
	const reg = await call("shot", {
		x: Math.max(0, editable.x - editable.w / 2 - 10), y: Math.max(0, editable.y - 15),
		w: Math.min(editable.w + 60, 1000), h: Math.min(editable.h + 40, 500), maxw: 800, path: PROOF,
	});
	ok("区域截图", existsSync(PROOF), `${reg.w}x${reg.h} → ${PROOF}`);
} catch (e) {
	fails.push(String(e.message ?? e));
	console.error("EXCEPTION:", e.message ?? e);
} finally {
	if (notepadPid) { try { execSync(`taskkill /pid ${notepadPid} /T /F`, { stdio: "ignore" }); } catch { } }
	proc.kill();
}
console.log(fails.length ? `\n结果：${fails.length} 项失败 → ${fails.join(" / ")}` : "\n结果：全部通过 ✓");
process.exit(fails.length ? 1 : 0);
