// E2E P25：内置办公技能（docx/pdf/pptx/xlsx 随包自带，启动自动部署）
// 前置：已删除 ~/.pi/agent/skills/{docx,pdf,pptx,xlsx} 与 .office-dismissed.json，应用带 --remote-debugging-port=9333 启动
import CDP from "chrome-remote-interface";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SKILLS = path.join(os.homedir(), ".pi", "agent", "skills");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = await (async () => {
	const tabs = await CDP.List({ port: 9333 });
	const page = tabs.find((t) => t.type === "page");
	return CDP({ target: page.webSocketDebuggerUrl });
})();
await client.Runtime.enable();
await client.Page.enable();
const ev = async (expr) => {
	const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.slice(0, 500));
	return r.result.value;
};
const shot = async (name) => {
	const r = await client.Page.captureScreenshot({ format: "png", fromSurface: true });
	fs.writeFileSync(`p25-${name}.png`, Buffer.from(r.data, "base64"));
	console.log(`📸 p25-${name}.png`);
};
let fails = 0;
const ok = (name, cond, extra = "") => {
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

// 1. 启动自动部署：4 个技能目录存在且注入了中文描述
for (const name of ["docx", "pdf", "pptx", "xlsx", "archive", "skill-creator", "viz"]) {
	const p = path.join(SKILLS, name, "SKILL.md");
	const md = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
	ok(`${name} 自动部署`, /description-zh:/.test(md) && /description:/.test(md));
}

// 2. 设置页 → 技能 tab → 内置办公技能卡片
await ev(`openSettings()`);
await sleep(400);
await ev(`document.querySelector('.tab[data-tab="skills"]').click()`);
await sleep(600);
ok("内置卡片可见", await ev(`!document.getElementById("office-card").classList.contains("hidden")`));
ok("7 行状态（P38 archive + P45 viz 入列）", (await ev(`document.querySelectorAll("#office-skills .checkbox-row").length`)) === 7);
ok("全部 ✓ 已装", (await ev(`[...document.querySelectorAll("#office-skills .checkbox-row b.ok-text")].length`)) === 7);

// 3. 重装 API（覆盖式，等价修复按钮逻辑）
const r = await ev(`window.openpi.skillsOfficeReinstall(["docx"])`);
ok("重装 API", r?.ok && JSON.stringify(r.installed) === JSON.stringify(["docx"]), JSON.stringify(r));

// 4. 忽略名单：删目录 + 写名单 → scan 报 dismissed；重装后名单清除
fs.rmSync(path.join(SKILLS, "docx"), { recursive: true, force: true });
fs.writeFileSync(path.join(SKILLS, ".office-dismissed.json"), JSON.stringify(["docx"]), "utf8");
ok("dismissed 识别", (await ev(`window.openpi.skillsOfficeScan()`)).skills.find((s) => s.name === "docx")?.dismissed === true);
await ev(`window.openpi.skillsOfficeReinstall(["docx"])`);
ok("重装清名单", fs.existsSync(path.join(SKILLS, "docx", "SKILL.md")) && !JSON.parse(fs.readFileSync(path.join(SKILLS, ".office-dismissed.json"), "utf8")).includes("docx"));

// 5. 技能列表里能看到内置技能（managed 组）
ok("技能列表含 docx", (await ev(`skillsCache.managed.some(s => s.name === "docx")`)) === true);

// 6. P38.7 去安装化：SKILL.md 不再引导安装 + setup.sh 秒退不装东西
const docxMd = fs.readFileSync(path.join(SKILLS, "docx", "SKILL.md"), "utf8");
ok("SKILL.md 已去安装化（内置运行时声明）", /Do Not Install/.test(docxMd) && !/Interactive environment check \+ install/.test(docxMd));
ok("SKILL.md 无 pip install 残留", !/pip install/.test(fs.readFileSync(path.join(SKILLS, "pptx", "SKILL.md"), "utf8")));
const so = spawnSync("bash", [path.join(SKILLS, "docx", "setup.sh")], { encoding: "utf8", timeout: 8000 });
ok("setup.sh 秒退不再安装", so.status === 0 && /无需安装/.test(so.stdout ?? ""), (so.stdout ?? "").slice(0, 50));
ok("pdf 脚本改用 fitz（免 pdf2image/poppler）", !/from pdf2image import/.test(fs.readFileSync(path.join(SKILLS, "pdf", "scripts", "pdf.py"), "utf8")));
const rtPy2 = path.join(path.resolve(import.meta.dirname, ".."), "resources", "runtime", "python", "python3.exe");
{
	const r = spawnSync(rtPy2, ["-c", "import pikepdf, pdfplumber, defusedxml; print('RT-OK')"], { encoding: "utf8", timeout: 60000 });
	ok("内置 runtime 含 pikepdf/pdfplumber/defusedxml", r.status === 0 && (r.stdout ?? "").includes("RT-OK"), (r.stderr ?? "").slice(0, 80));
}

await shot("office");
console.log(fails ? `\n${fails} 项失败` : "\n全部通过 ✓");
process.exit(fails ? 1 : 0);
