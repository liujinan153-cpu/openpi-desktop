// 一次性补丁 5：btn-dock 打开「打开面板」落地页
import fs from "node:fs";
const p = "src/renderer/app.js";
let s = fs.readFileSync(p, "utf8");
const target = '$("btn-dock").addEventListener("click", () => (dock.hidden ? showDock(dockLastTab) : closeDock()));';
if (!s.includes(target)) { console.error("MISS btn-dock"); process.exit(1); }
const ins = [
	"function showPicker() {",
	"\tdock.hidden = false;",
	"\tdockTab = null;",
	"\tfor (const [, el] of Object.entries(dockPanes)) el.hidden = true;",
	'\tdocument.querySelectorAll(".dock-tab").forEach((b) => b.classList.remove("on"));',
	'\tconst pk = document.getElementById("dock-picker");',
	"\tif (pk) pk.hidden = false;",
	"}",
	'$("btn-dock").addEventListener("click", () => (dock.hidden ? showPicker() : closeDock())); /* UI v3.1：打开=落地页 */',
].join("\r\n");
s = s.replace(target, ins);
fs.writeFileSync(p, s);
console.log("OK showPicker");
