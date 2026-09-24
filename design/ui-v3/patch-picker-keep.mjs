// 一次性补丁 9：落地页不再清空打开集合（已开面板标签保留）
import fs from "node:fs";
const p = "src/renderer/app.js";
let s = fs.readFileSync(p, "utf8");
const re = /function showPicker\(\) \{\r?\n\tdock\.hidden = false;\r?\n\tdockTab = null;\r?\n\tdockOpenPanes\.clear\(\);\r?\n\tdocument\.querySelectorAll\("\.dock-tab"\)\.forEach\(\(b\) => \(b\.hidden = false\)\);/;
if (!re.test(s)) { console.error("MISS showPicker block"); process.exit(1); }
const a = [
	"function showPicker() {",
	"\tdock.hidden = false;",
	"\tdockTab = null;",
	'\tdocument.querySelectorAll(".dock-tab").forEach((b) => (b.hidden = !dockOpenPanes.has(b.dataset.pane))); /* 已开面板保留 */',
].join("\r\n");
s = s.replace(re, a);
fs.writeFileSync(p, s);
console.log("OK showPicker keeps set");
