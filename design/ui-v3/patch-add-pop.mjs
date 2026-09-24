// 一次性补丁 10：＋ = 增量下拉菜单（锚定按钮下方），不再进落地页
import fs from "node:fs";
const p = "src/renderer/app.js";
let s = fs.readFileSync(p, "utf8");
let miss = 0;
const n = (b, a) => {
	if (!s.includes(b)) { console.error("MISS: " + b.slice(0, 66)); miss++; return; }
	s = s.split(b).join(a); console.log("OK");
};

// 1) 面板清单 + 增量菜单
n('let dockLastTab = "review"; // 关闭后再打开时恢复的标签',
	`let dockLastTab = "review"; // 关闭后再打开时恢复的标签
/* UI v3.1：＋ 增量菜单 —— 列出全部面板，已开的打 ✓，点选即加为标签（不进落地页） */
const DOCK_PANELS = [
	["review", "审核", "Ctrl+Shift+G"],
	["preview", "预览", "Ctrl+T"],
	["terminal", "终端", ""],
	["files", "文件", "Ctrl+P"],
	["subagents", "子智能体", ""],
	["tasks", "任务", ""],
	["agents", "指令", ""],
];
let addPop = null;
function closeAddPop() {
	if (addPop) { addPop.remove(); addPop = null; }
}
function showAddPop(anchor) {
	closeAddPop();
	addPop = document.createElement("div");
	addPop.id = "dock-add-pop";
	addPop.innerHTML = DOCK_PANELS.map(([k, label, kbd]) => {
		const open = dockOpenPanes.has(k);
		return \`<button class="dp-item\${open ? " cur" : ""}" data-pick="\${k}"><i data-lucide="\${({ review: "search", preview: "globe", terminal: "square-terminal", files: "folder", subagents: "bot", tasks: "zap", agents: "scroll-text" })[k]}"></i>\${label}\${open ? '<span class="dp-cur">✓</span>' : ""}\${kbd ? \\\`<span class="dp-kbd">\\\${kbd}</span>\\\` : ""}</button>\`;
	}).join("");
	document.body.appendChild(addPop);
	const r = anchor.getBoundingClientRect();
	addPop.style.top = r.bottom + 6 + "px";
	addPop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - addPop.offsetWidth - 12)) + "px";
	refreshIcons();
	addPop.addEventListener("click", (e) => {
		const item = e.target.closest(".dp-item");
		if (!item) return;
		closeAddPop();
		showDock(item.dataset.pick);
	});
}
document.addEventListener("mousedown", (e) => {
	if (addPop && !e.target.closest("#dock-add-pop") && !e.target.closest("#dock-add")) closeAddPop();
}, true);`);

// 2) dock-add 改弹增量菜单（不进落地页）
n('$("dock-add").addEventListener("click", showPicker); /* UI v3.1：＋ 回到落地页加面板 */',
	'$("dock-add").addEventListener("click", (e) => { e.stopPropagation(); addPop ? closeAddPop() : showAddPop(e.currentTarget); }); /* UI v3.1：＋=增量添加 */');

// 3) btn-dock：有已开面板则恢复上次面板，否则进落地页
n('$("btn-dock").addEventListener("click", () => (dock.hidden ? showPicker() : closeDock())); /* UI v3.1：打开=落地页 */',
	'$("btn-dock").addEventListener("click", () => (dock.hidden ? (dockOpenPanes.size ? showDock(dockLastTab) : showPicker()) : closeDock())); /* UI v3.1：有标签恢复标签，无则落地页 */');

fs.writeFileSync(p, s);
console.log(miss ? `完成（${miss} 处未匹配）` : "全部匹配");

// ---- CSS：增量菜单 ----
const c = "src/renderer/style.css";
let cs = fs.readFileSync(c, "utf8");
cs += `\n/* ================= UI v3.1：＋ 增量下拉菜单（锚定 dock-add） ================= */\n#dock-add-pop {\n\tposition: fixed; z-index: 1200; min-width: 190px; max-height: 340px; overflow-y: auto;\n\tbackground: var(--bg1); border: 1px solid var(--border2); border-radius: 12px;\n\tbox-shadow: var(--shadow-pop); padding: 5px;\n}\n#dock-add-pop .dp-item { margin-bottom: 2px; }\n#dock-add-pop .dp-cur { margin-left: auto; flex: none; color: var(--green); font-size: 11px; }\n`;
fs.writeFileSync(c, cs);
console.log("OK css");
