// 一次性补丁 8：多开剩余接线（CRLF 容忍）
import fs from "node:fs";
const p = "src/renderer/app.js";
let s = fs.readFileSync(p, "utf8");
let miss = 0;
const esc = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const n = (b, a) => {
	const re = new RegExp(b.split("\n").map(esc).join("\r?\n"));
	if (!re.test(s)) { console.error("MISS: " + b.slice(0, 55)); miss++; return; }
	s = s.replace(re, a.replace(/\n/g, "\r\n")); console.log("OK");
};

// showDock：登记打开集合 + 同步标签可见性
n('\tdock.classList.remove("picker-mode");\n\tconst dockPk = document.getElementById("dock-picker");\n\tif (dockPk) dockPk.hidden = true;',
	'\tdock.classList.remove("picker-mode");\n\tconst dockPk = document.getElementById("dock-picker");\n\tif (dockPk) dockPk.hidden = true;\n\tdockOpenPanes.add(tab);\n\tdocument.querySelectorAll(".dock-tab").forEach((b) => (b.hidden = !dockOpenPanes.has(b.dataset.pane)));');

// showPicker：落地页模式清空打开集合
n('function showPicker() {\n\tdock.hidden = false;\n\tdockTab = null;',
	'function showPicker() {\n\tdock.hidden = false;\n\tdockTab = null;\n\tdockOpenPanes.clear();\n\tdocument.querySelectorAll(".dock-tab").forEach((b) => (b.hidden = false));');

fs.writeFileSync(p, s);
console.log(miss ? `完成（${miss} 处未匹配）` : "全部匹配");
