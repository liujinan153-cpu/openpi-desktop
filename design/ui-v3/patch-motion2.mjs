// 一次性补丁 3：剩余四处动效（纯字符串、单行匹配）
import fs from "node:fs";
const p = "src/renderer/style.css";
let s = fs.readFileSync(p, "utf8");
let miss = 0;
const n = (b, a) => {
	if (!s.includes(b)) { console.error("MISS: " + b.slice(0, 60)); miss++; return; }
	s = s.split(b).join(a); console.log("OK");
};

// 1) 发送键按压回弹
n(".btn-send:hover { filter: brightness(.93); transform: translateY(-1px) scale(1.05); }",
	".btn-send:hover { filter: brightness(.93); transform: translateY(-1px) scale(1.05); }\n.btn-send:active { transform: translateY(0) scale(.94); }");

// 2) 回底按钮：换 accent 高亮为中性缩放 + 过渡
n("#scroll-down:hover { border-color: var(--accent); color: var(--accent); }",
	"#scroll-down:hover { border-color: var(--line2); color: var(--text); transform: scale(1.08); }");
n("#scroll-down { position: absolute; right: 28px; bottom: 20px; width: 34px; height: 34px; border-radius: 50%;",
	"#scroll-down { position: absolute; right: 28px; bottom: 20px; width: 34px; height: 34px; border-radius: 50%; transition: transform var(--spring), border-color var(--t-fast), color var(--t-fast);");

// 3) 工具行悬停右滑
n(".tool {\n\tmargin-top: 10px; border: 1px solid var(--border); border-radius: var(--r-sm);\n\tbackground: transparent; overflow: hidden; box-shadow: none;\n}",
	".tool {\n\tmargin-top: 10px; border: 1px solid var(--border); border-radius: var(--r-sm);\n\tbackground: transparent; overflow: hidden; box-shadow: none;\n\ttransition: background var(--t-fast), transform var(--t-fast);\n}\n.tool:hover { background: var(--hover); transform: translateX(2px); }");

// 4) dock-tab 下划线滑动过渡
n("cursor: pointer; transition: color var(--t-fast), background var(--t-fast); display: inline-flex; align-items: center; gap: 4px;",
	"cursor: pointer; transition: color var(--t-fast), background var(--t-fast), box-shadow var(--t); display: inline-flex; align-items: center; gap: 4px;");

fs.writeFileSync(p, s);
console.log(miss ? `完成（${miss} 处未匹配）` : "全部匹配");
