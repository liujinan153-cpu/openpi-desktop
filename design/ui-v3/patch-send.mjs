// 一次性补丁：btn-send 发送/停止态改 lucide 图标（.bs-t 隐藏文本锚点保 e2e 兼容）
// 注意：工作副本是 CRLF 行尾，匹配一律容忍 \r
import fs from "node:fs";
const p = "src/renderer/app.js";
let s = fs.readFileSync(p, "utf8");
const re = /\tbtnSend\.textContent = on \? "\u25a0" : "\u2191";\r?\n/;
if (!re.test(s)) { console.error("MISS setStreaming line"); process.exit(1); }
const a = [
	"\t/* UI v3.1：可见层走 lucide 图标；.bs-t 隐藏文本锚点保留供 e2e textContent 断言 */",
	'\tconst want = on ? "stop" : "send";',
	"\tif (btnSend.dataset.st !== want) {",
	"\t\tbtnSend.dataset.st = want;",
	"\t\tbtnSend.innerHTML = on",
	'\t\t\t? \'<span class="bs-t">\u25a0</span><i data-lucide="square" class="bs-ic"></i>\'',
	'\t\t\t: \'<span class="bs-t">\u2191</span><i data-lucide="arrow-up" class="bs-ic"></i>\';',
	"\t\trefreshIcons();",
	"\t}",
].join("\r\n");
s = s.replace(re, a);
fs.writeFileSync(p, s);
console.log("OK setStreaming");

const pi = "src/renderer/index.html";
let h = fs.readFileSync(pi, "utf8");
const hb = '<button id="btn-send" class="btn-send" title="发送">↑</button>';
if (!h.includes(hb)) { console.error("MISS btn-send"); process.exit(1); }
h = h.replace(hb, '<button id="btn-send" class="btn-send" title="发送"><span class="bs-t">↑</span><i data-lucide="arrow-up" class="bs-ic"></i></button>');
fs.writeFileSync(pi, h);
console.log("OK index");
