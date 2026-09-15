import fs from "node:fs";
let s = fs.readFileSync("src/main/agent-host.mjs", "utf8");
const old1 = '\t\t\t\tconst mode = hostRef.approvalMode;\n\t\t\t\tif (mode === "full-auto") return undefined; // 全自动：全放行';
const new1 = '\t\t\t\tconst mode = hostRef.approvalMode;\n\t\t\t\tconsole.error(`[approval] tool=${event.toolName} mode=${mode} hasUI=${ctx.hasUI}`);\n\t\t\t\tif (mode === "full-auto") return undefined; // 全自动：全放行';
if (!s.includes(old1)) throw new Error("未匹配");
s = s.replace(old1, new1);
fs.writeFileSync("src/main/agent-host.mjs", s);
console.log("日志已加");
