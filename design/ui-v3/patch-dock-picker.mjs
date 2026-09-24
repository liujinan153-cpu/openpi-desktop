// 一次性补丁 4：配色单行补完 + dock「打开面板」落地页
// 单行匹配，不受 CRLF 影响
import fs from "node:fs";
const css = "src/renderer/style.css";
let c = fs.readFileSync(css, "utf8");
let miss = 0;
const n = (b, a) => {
	if (!c.includes(b)) { console.error("MISS(css): " + b.slice(0, 60)); miss++; return; }
	c = c.split(b).join(a); console.log("OK " + b.slice(0, 40));
};
// 配色单行补完
n("--bg0: #0a0a0c;", "--bg0: #0a0a09;");
n("--bg: #0c0c0e;", "--bg: #0c0c0b;");
n("--bg2: #101013;", "--bg2: #111110;");
n("--bg3: #17171c;", "--bg3: #181816;");
n("--bg4: #1f1f26;", "--bg4: #201f1d;");
n("--bg0: #e9e4da;", "--bg0: #f0eee9;");
n("--bg: #fbfaf6;", "--bg: #ffffff;");
n("--bg2: #f4efe6;", "--bg2: #faf9f6;");
n("--bg3: #f2eee5;", "--bg3: #f4f3ef;");
n("--bg4: #e8e2d6;", "--bg4: #eae8e2;");
n("--surface: #f4efe6;", "--surface: #faf9f6;");
n("--surface-2: #efeadd;", "--surface-2: #f4f3ef;");
n("--border: rgba(88, 68, 40, .1);", "--border: rgba(60, 55, 45, .1);");
n("--border2: rgba(88, 68, 40, .18);", "--border2: rgba(60, 55, 45, .18);");
n("--hover: rgba(88, 68, 40, .055);", "--hover: rgba(60, 55, 45, .05);");
n("--active: rgba(88, 68, 40, .09);", "--active: rgba(60, 55, 45, .08);");
n("--shadow-lg: 0 10px 34px rgba(70, 50, 25, .12);", "--shadow-lg: 0 10px 34px rgba(50, 46, 40, .12);");
n("--shadow-pop: 0 18px 60px rgba(70, 50, 25, .18);", "--shadow-pop: 0 18px 60px rgba(50, 46, 40, .18);");
n("--shadow-lift: 0 8px 24px rgba(70, 50, 25, .14);", "--shadow-lift: 0 8px 24px rgba(50, 46, 40, .14);");
// dock：宽度默认 520 + 标签紧凑一次展示全
n("width: var(--dock-w, 480px); min-width: var(--dock-w, 480px);", "width: var(--dock-w, 520px); min-width: var(--dock-w, 520px);");
n("font: 600 12px var(--sans); padding: 5px 9px; border-radius: var(--r-sm);", "font: 600 11.5px var(--sans); padding: 5px 6px; border-radius: var(--r-xs);");
n("background: var(--bg4); color: var(--dim); font-size: 10px; font-weight: 600;", "background: var(--bg4); color: var(--dim); font-size: 9.5px; font-weight: 600;");
n("border-radius: 999px; padding: 0 5px; line-height: 14px; min-width: 14px;", "border-radius: 999px; padding: 0 4px; line-height: 13px; min-width: 13px;");
n("display: flex; align-items: center; gap: 1px; padding: 6px 6px;", "display: flex; align-items: center; gap: 0; padding: 5px 5px;");
fs.writeFileSync(css, c);
console.log(miss ? `css 完成（${miss} 处未匹配）` : "css 全部匹配");

// ---- dock「打开面板」落地页 ----
const ih = "src/renderer/index.html";
let h = fs.readFileSync(ih, "utf8");
const anchor = '\t\t\t\t<div class="spacer"></div>\n\t\t\t\t<button id="dock-close" class="icon-btn" title="关闭面板"><i data-lucide="x"></i></button>';
if (!h.includes(anchor)) { console.error("MISS dock-tabs tail"); process.exit(1); }
const picker = [
	anchor,
	'\t\t\t</div>',
	'\t\t\t<!-- UI v3.1：面板落地页（对标 Pi-Desktop 打开面板）——无激活面板时展示，点选进入 -->',
	'\t\t\t<div id="dock-picker" hidden>',
	'\t\t\t\t<div class="dp-title">打开面板</div>',
	'\t\t\t\t<div class="dp-sub">选择要在侧边面板中打开的面板。</div>',
	'\t\t\t\t<button class="dp-item" data-pick="review"><i data-lucide="search"></i>审核</button>',
	'\t\t\t\t<button class="dp-item" data-pick="preview"><i data-lucide="globe"></i>预览</button>',
	'\t\t\t\t<button class="dp-item" data-pick="terminal"><i data-lucide="square-terminal"></i>终端</button>',
	'\t\t\t\t<button class="dp-item" data-pick="files"><i data-lucide="folder"></i>文件</button>',
	'\t\t\t\t<button class="dp-item" data-pick="subagents"><i data-lucide="bot"></i>子智能体</button>',
	'\t\t\t\t<button class="dp-item" data-pick="tasks"><i data-lucide="zap"></i>任务</button>',
	'\t\t\t\t<button class="dp-item" data-pick="agents"><i data-lucide="scroll-text"></i>指令</button>',
	'\t\t\t</div>',
].join("\n");
h = h.replace(anchor, picker);
fs.writeFileSync(ih, h);
console.log("OK picker markup");

// ---- app.js：picker 显示/选择接线 ----
const aj = "src/renderer/app.js";
let a = fs.readFileSync(aj, "utf8");
const sb = '\tdock.hidden = false;\n\tfor (const [k, el] of Object.entries(dockPanes)) el.hidden = k !== tab;';
if (!a.includes(sb)) { console.error("MISS showDock body"); process.exit(1); }
a = a.replace(sb, [
	"\tdock.hidden = false;",
	"\tfor (const [k, el] of Object.entries(dockPanes)) el.hidden = k !== tab;",
	'\tdocument.getElementById("dock-picker").hidden = true; /* UI v3.1：进入面板即收起落地页 */',
].join("\r\n"));
const tb = 'document.querySelectorAll(".dock-tab").forEach((b) => b.addEventListener("click", () => showDock(b.dataset.pane)));';
if (!a.includes(tb)) { console.error("MISS tab bind"); process.exit(1); }
a = a.replace(tb, [
	tb,
	'\tdocument.querySelectorAll("#dock-picker .dp-item").forEach((b) => b.addEventListener("click", () => showDock(b.dataset.pick))); /* UI v3.1：落地页点选 */',
	"/* UI v3.1：dock 打开且无激活面板时展示「打开面板」落地页 */",
	'document.addEventListener("DOMContentLoaded", () => {',
	'	const pk = document.getElementById("dock-picker");',
	'	new MutationObserver(() => { if (pk && !dock.hidden && !dockTab) pk.hidden = false; }).observe(dock, { attributes: true, attributeFilter: ["hidden"] });',
	"});",
].join("\r\n"));
fs.writeFileSync(aj, a);
console.log("OK app wiring");
