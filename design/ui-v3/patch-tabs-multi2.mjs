// 一次性补丁 7：dock 标签条多开（浏览器式）——打开集合 + 按可见性同步 + ✕ 捕获阶段关闭
import fs from "node:fs";
const p = "src/renderer/app.js";
let s = fs.readFileSync(p, "utf8");
let miss = 0;
const n = (b, a) => {
	if (!s.includes(b)) { console.error("MISS: " + b.slice(0, 66)); miss++; return; }
	s = s.split(b).join(a); console.log("OK");
};

// 1) 打开集合
n("let dockTab = null; // 当前打开的 pane：review | preview | terminal | files | null",
	"let dockTab = null; // 当前打开的 pane：review | preview | terminal | files | null\nconst dockOpenPanes = new Set(); // UI v3.1：标签条多开——已打开面板集合（浏览器式标签）");

// 2) showDock：登记打开集合 + 同步标签可见性（未打开的不显示）
n("\tdock.classList.remove(\"picker-mode\"); /* UI v3.1：进入面板=标签条模式 */\n\tconst dockPk = document.getElementById(\"dock-picker\");\n\tif (dockPk) dockPk.hidden = true;",
	"\tdock.classList.remove(\"picker-mode\"); /* UI v3.1：进入面板=标签条模式 */\n\tconst dockPk = document.getElementById(\"dock-picker\");\n\tif (dockPk) dockPk.hidden = true;\n\tdockOpenPanes.add(tab);\n\tdocument.querySelectorAll(\".dock-tab\").forEach((b) => (b.hidden = !dockOpenPanes.has(b.dataset.pane)));");

// 3) ✕ 关闭：捕获阶段拦截（先于标签自身的 showDock）
n('document.querySelectorAll(".dock-tab").forEach((b) => b.addEventListener("click", () => showDock(b.dataset.pane)));',
	'document.querySelectorAll(".dock-tab").forEach((b) => b.addEventListener("click", () => showDock(b.dataset.pane)));\n/* UI v3.1：标签 ✕ 关闭单个面板（捕获阶段，先于标签切页）；最后一个关闭则回落地页 */\n$("dock-tabs").addEventListener("click", (e) => {\n\tconst x = e.target.closest(".tb-x");\n\tif (!x) return;\n\te.preventDefault(); e.stopPropagation();\n\tconst pane = x.closest(".dock-tab")?.dataset.pane;\n\tif (!pane) return;\n\tdockOpenPanes.delete(pane);\n\tconst btn = document.querySelector(`.dock-tab[data-pane="${pane}"]`);\n\tif (btn) btn.hidden = true;\n\tif (dockTab === pane) {\n\t\tconst next = [...dockOpenPanes][0];\n\t\tnext ? showDock(next) : showPicker();\n\t}\n}, true);');

// 4) showPicker：落地页模式清空打开集合（重新开始）
n("function showPicker() {\n\tdock.hidden = false;\n\tdockTab = null;",
	"function showPicker() {\n\tdock.hidden = false;\n\tdockTab = null;\n\tdockOpenPanes.clear();\n\tdocument.querySelectorAll(\".dock-tab\").forEach((b) => (b.hidden = false)); /* 落地页模式标签条整体隐藏，无谓可见性 */");

fs.writeFileSync(p, s);
console.log(miss ? `完成（${miss} 处未匹配）` : "全部匹配");
