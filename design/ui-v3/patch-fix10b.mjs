// 修复补丁 10b：嵌套模板字符串转义损坏 → 拼接写法
import fs from "node:fs";
const p = "src/renderer/app.js";
let s = fs.readFileSync(p, "utf8");
const bad = s.split("\n").find((l) => l.includes("dp-kbd") && l.includes("\\`"));
if (!bad) { console.error("MISS broken line"); process.exit(1); }
const ICONS = '{ review: "search", preview: "globe", terminal: "square-terminal", files: "folder", subagents: "bot", tasks: "zap", agents: "scroll-text" }';
const fixed = "\t\treturn '<button class=\"dp-item' + (open ? \" cur\" : \"\") + '\" data-pick=\"' + k + '\"><i data-lucide=\"' + ({" + ICONS + "})[k] + '\"></i>' + label + (open ? '<span class=\"dp-cur\">✓</span>' : \"\") + (kbd ? '<span class=\"dp-kbd\">' + kbd + '</span>' : \"\") + '</button>';";
s = s.replace(bad, fixed);
fs.writeFileSync(p, s);
console.log("OK fixed");
