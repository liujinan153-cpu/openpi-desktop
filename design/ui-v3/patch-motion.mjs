// 一次性补丁：质感投影 + 互动动画批（v3.1 动效层）
// 注意：工作副本 CRLF/LF 混杂，全部用单行精确匹配（容忍 \r 由 includes 的行内匹配保证）
import fs from "node:fs";
const p = "src/renderer/style.css";
let s = fs.readFileSync(p, "utf8");
let miss = 0;
const n = (b, a) => {
	if (!s.includes(b)) { console.error("MISS: " + b.slice(0, 60)); miss++; return; }
	s = s.split(b).join(a); console.log("OK");
};

// 1) 动效 tokens：弹性曲线 + 悬停投影
n("\t--t-fast: .13s cubic-bezier(.3, 0, .3, 1); /* 统一微动效：只回应操作 */",
	"\t--t-fast: .13s cubic-bezier(.3, 0, .3, 1); /* 统一微动效：只回应操作 */\n\t--spring: .28s cubic-bezier(.34, 1.56, .64, 1); /* UI v3.1：弹性抬升（轻微过冲） */\n\t--shadow-lift: 0 8px 24px rgba(0, 0, 0, .28); /* 悬停浮起专用 */");

// 2) 会话行：悬停右滑
n(".s-item:hover { background: var(--hover); }",
	".s-item:hover { background: var(--hover); transform: translateX(2px); } /* UI v3.1：右滑 */\n.s-item { transition: background var(--t-fast), transform var(--t-fast); }");

// 3) 图标钮：缩放反馈
n(".icon-btn:hover { color: var(--text); background: var(--hover); }",
	".icon-btn:hover { color: var(--text); background: var(--hover); transform: scale(1.05); }\n.icon-btn:active { transform: scale(.94); }\n.icon-btn { transition: background var(--t-fast), color var(--t-fast), transform var(--spring); }");

// 4) 按钮：全局微抬（primary 已有单独规则，保持）
n(".btn:hover { border-color: var(--border2); background: var(--hover); }",
	".btn:hover { border-color: var(--border2); background: var(--hover); transform: translateY(-1px); }");

// 5) chips：微抬 + 按压
n(".chip:hover { border-color: var(--border2); background: var(--hover); color: var(--text); }",
	".chip:hover { border-color: var(--border2); background: var(--hover); color: var(--text); transform: translateY(-1px); }\n.chip:active { transform: translateY(0) scale(.97); }\n.chip { transition: border-color var(--t-fast), background var(--t-fast), color var(--t-fast), transform var(--spring); }");

// 6) 任务卡：弹性抬升 + 投影升级 + 图标缩放
n(".w-task:hover { border-color: var(--border2); background: var(--hover); transform: translateY(-2px); box-shadow: var(--shadow-sm); }",
	".w-task:hover { border-color: var(--border2); background: var(--hover); transform: translateY(-3px); box-shadow: var(--shadow-lift); } /* UI v3.1：弹性浮起 */\n.w-task .ic { transition: transform var(--spring); }\n.w-task:hover .ic { transform: scale(1.12) rotate(-4deg); }");
n("\ttransition: border-color var(--t-fast), background var(--t-fast); text-align: left; min-height: 0; display: flex; flex-direction: column; gap: 6px;",
	"\ttransition: border-color var(--t-fast), background var(--t-fast), transform var(--spring), box-shadow var(--spring); text-align: left; min-height: 0; display: flex; flex-direction: column; gap: 6px;");

// 7) 发送键：呼吸式缩放
n(".btn-send:hover { filter: brightness(.93); transform: translateY(-1px); }",
	".btn-send:hover { filter: brightness(.93); transform: translateY(-1px) scale(1.05); }");
n(".btn-send:active { transform: translateY(0) scale(.96); }",
	".btn-send:active { transform: translateY(0) scale(.94); }");

// 8) 回底按钮：缩放
n("#scroll-down:hover { border-color: var(--line2); color: var(--dim); }",
	"#scroll-down:hover { border-color: var(--line2); color: var(--text); transform: scale(1.08); }\n#scroll-down { transition: transform var(--spring), border-color var(--t-fast), color var(--t-fast); }");

// 9) 工具行：右滑
n(".tool:hover { background: var(--hover); }",
	".tool:hover { background: var(--hover); transform: translateX(2px); } /* UI v3.1：右滑 */\n.tool { transition: background var(--t-fast), transform var(--t-fast); border-color: transparent; }");

// 10) dock-tab：下划线滑动过渡
n(".dock-tab {\n\tborder: none; background: transparent; color: var(--dim);\n\tfont: 600 12px var(--sans); padding: 5px 9px; border-radius: var(--r-sm);\n\tcursor: pointer; transition: color var(--t-fast), background var(--t-fast); display: inline-flex; align-items: center; gap: 4px;",
	".dock-tab {\n\tborder: none; background: transparent; color: var(--dim);\n\tfont: 600 12px var(--sans); padding: 5px 9px; border-radius: var(--r-sm);\n\tcursor: pointer; transition: color var(--t-fast), background var(--t-fast), box-shadow var(--t); display: inline-flex; align-items: center; gap: 4px;");

// 11) 亮色主题投影同步
n("\t--shadow-sm: 0 1px 2px rgba(70, 50, 25, .07);",
	"\t--shadow-sm: 0 1px 2px rgba(70, 50, 25, .07);\n\t--shadow-lift: 0 8px 24px rgba(70, 50, 25, .14);");

fs.writeFileSync(p, s);
console.log(miss ? `完成（${miss} 处未匹配）` : "全部匹配");
