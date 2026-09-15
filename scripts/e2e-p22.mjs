// E2E P22：/ 技能引用菜单 + 办公技能（docx/pdf/pptx/xlsx）安装 + 中文功能描述
// 前置：electron --remote-debugging-port=9333 已启动
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (client, name) => {
	const r = await client.Page.captureScreenshot({ format: "png", fromSurface: true });
	fs.writeFileSync(`p22-${name}.png`, Buffer.from(r.data, "base64"));
	console.log(`📸 p22-${name}.png`);
};
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
const key = (type, key) =>
	client.Input.dispatchKeyEvent({ type, key, windowsVirtualKeyCode: { ArrowDown: 40, ArrowUp: 38, Enter: 13 }[key] ?? 0 });

console.log("== 1. 办公技能已装入 pi 技能库（含中文描述） ==");
for (const k of ["docx", "pdf", "pptx", "xlsx"]) {
	const p = path.join(HOME, ".pi/agent/skills", k, "SKILL.md");
	const ok = fs.existsSync(p);
	const zh = ok && /^description-zh:/m.test(fs.readFileSync(p, "utf8"));
	console.log(`${k}: 存在=${ok} 中文描述=${zh ? "✓" : "✗"}`);
}
console.log("技能数:", fs.readdirSync(path.join(HOME, ".pi/agent/skills")).join(", "));

console.log("== 2. 技能页 UI 显示中文描述 ==");
await ev(`openSettings()`);
await sleep(400);
await ev(`document.querySelector('.tab[data-tab="skills"]').click()`);
await sleep(600);
const zhShown = await ev(`(() => {
  const p = [...document.querySelectorAll(".skill-item b")].find(b => b.textContent === "docx")?.parentElement.querySelector("p");
  return p ? { text: p.textContent.slice(0, 40), isZh: /[\\u4e00-\\u9fff]/.test(p.textContent) } : null;
})()`);
console.log("docx 条目:", JSON.stringify(zhShown));
await shot(client, "skills-zh");

console.log("== 3. / 技能引用菜单 ==");
await ev(`document.getElementById("btn-settings-close").click()`);
await sleep(300);
await ev(`(async()=>{ const i=document.getElementById("input"); i.focus(); i.value="/"; i.dispatchEvent(new Event("input",{bubbles:true})); })()`);
await sleep(400);
console.log("菜单可见:", await ev(`!document.getElementById("slash-menu").hidden`));
console.log("条目数:", await ev(`document.querySelectorAll(".slash-item").length`));
await ev(`(async()=>{ const i=document.getElementById("input"); i.value="/doc"; i.dispatchEvent(new Event("input",{bubbles:true})); })()`);
await sleep(300);
const items = await ev(`[...document.querySelectorAll(".slash-item")].map(el => el.querySelector("b").textContent + " " + el.querySelector("span").textContent.slice(0, 20))`);
console.log("过滤 /doc →", JSON.stringify(items));
await shot(client, "slash-menu");
await key("keyDown", "ArrowDown");
await key("keyDown", "Enter");
await sleep(200);
console.log("选中后输入框:", JSON.stringify(await ev(`document.getElementById("input").value`)));
console.log("菜单已关:", await ev(`document.getElementById("slash-menu").hidden`));

console.log("== 4. 发送展开（保证 Agent 必定感知技能引用） ==");
console.log(await ev(`expandSkillRef("/xlsx 帮我做个销量统计表").slice(0, 40)`));
console.log(await ev(`expandSkillRef("普通消息")`));

console.log("== 完成 ==");
process.exit(0);
