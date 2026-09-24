// 一次性补丁 12：＋ 增量下拉菜单回归（替换 showPicker 绑定），btn-dock 恢复语义
import fs from "node:fs";
const p = "src/renderer/app.js";
let s = fs.readFileSync(p, "utf8");
let miss = 0;
const n = (b, a) => {
	if (!s.includes(b)) { console.error("MISS: " + b.slice(0, 66)); miss++; return; }
	s = s.split(b).join(a); console.log("OK");
};

const OLD = '$("dock-add").addEventListener("click", showPicker); /* UI v3.1：＋ 回到落地页加面板 */';
const NEW = [
	'/* UI v3.1：＋ 增量菜单 —— 列出全部面板，已开的打 ✓，点选即加为标签（不进落地页） */',
	'const DOCK_PANELS = [',
	'\t["review", "审核", "Ctrl+Shift+G"],',
	'\t["preview", "预览", "Ctrl+T"],',
	'\t["terminal", "终端", ""],',
	'\t["files", "文件", "Ctrl+P"],',
	'\t["subagents", "子智能体", ""],',
	'\t["tasks", "任务", ""],',
	'\t["agents", "指令", ""],',
	'];',
	'const DOCK_ICONS = { review: "search", preview: "globe", terminal: "square-terminal", files: "folder", subagents: "bot", tasks: "zap", agents: "scroll-text" };',
	'let addPop = null;',
	"function closeAddPop() {",
	"\tif (addPop) { addPop.remove(); addPop = null; }",
	"}",
	"function showAddPop(anchor) {",
	"\tcloseAddPop();",
	"\taddPop = document.createElement(\"div\");",
	'\taddPop.id = "dock-add-pop";',
	"\taddPop.innerHTML = DOCK_PANELS.map(([k, label, kbd]) => {",
	'\t\tconst open = dockOpenPanes.has(k);',
	"\t\tlet h = '<button class=\"dp-item' + (open ? \" on\" : \"\") + '\" data-pick=\"' + k + '\"><i data-lucide=\"' + DOCK_ICONS[k] + '\"></i>' + label;",
	"\t\tif (open) h += '<span class=\"dp-cur\">✓</span>';",
	"\t\tif (kbd) h += '<span class=\"dp-kbd\">' + kbd + '</span>';",
	"\t\th += '</button>';",
	"\t\treturn h;",
	"\t}).join(\"\");",
	"\tdocument.body.appendChild(addPop);",
	"\tconst r = anchor.getBoundingClientRect();",
	"\taddPop.style.top = r.bottom + 6 + \"px\";",
	'\taddPop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - addPop.offsetWidth - 12)) + "px";',
	"\trefreshIcons();",
	"\taddPop.addEventListener(\"click\", (e) => {",
	'\t\tconst item = e.target.closest(".dp-item");',
	"\t\tif (!item) return;",
	"\t\tcloseAddPop();",
	"\t\tshowDock(item.dataset.pick);",
	"\t});",
	"}",
	'$("dock-add").addEventListener("click", (e) => { e.stopPropagation(); addPop ? closeAddPop() : showAddPop(e.currentTarget); }); /* UI v3.1：＋=增量添加 */',
	'document.addEventListener("mousedown", (e) => { if (addPop && !e.target.closest("#dock-add-pop") && !e.target.closest("#dock-add")) closeAddPop(); }, true);',
].join("\n");
n(OLD, NEW);

// btn-dock：有已开面板恢复上次面板，无则落地页
n('$("btn-dock").addEventListener("click", () => (dock.hidden ? showPicker() : closeDock())); /* UI v3.1：打开=落地页 */',
	'$("btn-dock").addEventListener("click", () => (dock.hidden ? (dockOpenPanes.size ? showDock(dockLastTab) : showPicker()) : closeDock())); /* UI v3.1：有标签恢复标签，无则落地页 */');

fs.writeFileSync(p, s);
console.log(miss ? `完成（${miss} 处未匹配）` : "全部匹配");
