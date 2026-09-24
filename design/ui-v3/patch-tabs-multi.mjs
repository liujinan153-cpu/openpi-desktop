// 一次性补丁 6：dock 标签条多开（浏览器式）——7 个标签挂 ✕ 关闭钮
import fs from "node:fs";
const p = "src/renderer/index.html";
let s = fs.readFileSync(p, "utf8");
let miss = 0;
const n = (b, a) => {
	if (!s.includes(b)) { console.error("MISS: " + b.slice(0, 70)); miss++; return; }
	s = s.split(b).join(a); console.log("OK");
};
n('<button class="dock-tab" data-pane="review" title="工作区改动审阅 (Ctrl+Shift+G)"><i data-lucide="search"></i> 审核 <span id="review-cnt" class="dock-cnt" hidden></span></button>',
	'<button class="dock-tab" data-pane="review" title="工作区改动审阅 (Ctrl+Shift+G)"><i data-lucide="search"></i> 审核 <span id="review-cnt" class="dock-cnt" hidden></span><span class="tb-x" title="关闭"><i data-lucide="x"></i></span></button>');
n('<button class="dock-tab" data-pane="preview" title="实时预览 (Ctrl+T)"><i data-lucide="globe"></i> 预览</button>',
	'<button class="dock-tab" data-pane="preview" title="实时预览 (Ctrl+T)"><i data-lucide="globe"></i> 预览<span class="tb-x" title="关闭"><i data-lucide="x"></i></span></button>');
n('<button class="dock-tab" data-pane="files" title="工作区文件 (Ctrl+P)"><i data-lucide="folder"></i> 文件</button>',
	'<button class="dock-tab" data-pane="files" title="工作区文件 (Ctrl+P)"><i data-lucide="folder"></i> 文件<span class="tb-x" title="关闭"><i data-lucide="x"></i></span></button>');
n('<button class="dock-tab" data-pane="subagents" title="子智能体实时动作（并行 worker）"><i data-lucide="bot"></i> 子智能体 <span id="subagents-cnt" class="dock-cnt" hidden></span></button>',
	'<button class="dock-tab" data-pane="subagents" title="子智能体实时动作（并行 worker）"><i data-lucide="bot"></i> 子智能体 <span id="subagents-cnt" class="dock-cnt" hidden></span><span class="tb-x" title="关闭"><i data-lucide="x"></i></span></button>');
n('<button class="dock-tab" data-pane="tasks" title="后台并行任务（多任务同时跑，互不阻塞）"><i data-lucide="zap"></i> 任务 <span id="tasks-cnt" class="dock-cnt" hidden></span></button>',
	'<button class="dock-tab" data-pane="tasks" title="后台并行任务（多任务同时跑，互不阻塞）"><i data-lucide="zap"></i> 任务 <span id="tasks-cnt" class="dock-cnt" hidden></span><span class="tb-x" title="关闭"><i data-lucide="x"></i></span></button>');
n('<button class="dock-tab" data-pane="agents" title="AGENTS.md 指令文件（注入每次会话的系统提示词）"><i data-lucide="scroll-text"></i> 指令</button>',
	'<button class="dock-tab" data-pane="agents" title="AGENTS.md 指令文件（注入每次会话的系统提示词）"><i data-lucide="scroll-text"></i> 指令<span class="tb-x" title="关闭"><i data-lucide="x"></i></span></button>');
fs.writeFileSync(p, s);
console.log(miss ? `完成（${miss} 处未匹配）` : "全部匹配");
