// P55 项目记忆单元测试
// 运行：node scripts/unit-p55.cjs
const assert = (c, m) => { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✅ " + m); };
const fs = require("fs");
const os = require("os");
const path = require("path");
const mem = require("../src/main/memory-tools.mjs");

const ws = path.join(os.tmpdir(), "p55-unit");
fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(ws, { recursive: true });

// 未绑定 workspace
mem.setMemoryWorkspace(null);
const r0 = JSON.stringify(mem.memoryTools[0].execute("t", {}));
assert(r0.includes("未绑定工作区"), "未绑定 workspace → memory_read 友好报错");
assert(mem.memorySystemPrompt() === "", "未绑定 workspace → 不注入提示");

// 绑定 + 写读
mem.setMemoryWorkspace(ws);
const rw = JSON.stringify(mem.memoryTools[1].execute("t", { content: "P55-MEMO 本项目测试框架为 vitest" }));
assert(rw.includes("已写入"), "memory_write 追加成功");
const rr = JSON.stringify(mem.memoryTools[0].execute("t", {}));
assert(rr.includes("P55-MEMO"), "memory_read 读回内容");
assert(fs.existsSync(path.join(ws, ".openpi", "MEMORY.md")), "文件落在 <ws>/.openpi/MEMORY.md");
assert(mem.memorySystemPrompt().includes("P55-MEMO"), "系统提示注入记忆内容");

// 空内容拒绝
const re = JSON.stringify(mem.memoryTools[1].execute("t", { content: "  " }));
assert(re.includes("不能为空"), "空内容拒绝");

// 覆写
mem.memoryTools[1].execute("t", { content: "P55-MEMO2 覆写版", mode: "replace" });
const rr2 = mem.memoryTools[0].execute("t", {}).content[0].text;
assert(rr2.includes("P55-MEMO2") && !rr2.includes("本项目测试框架"), "mode=replace 覆写成功");

// 超长截断
mem.memoryTools[1].execute("t", { content: "X".repeat(3000), mode: "replace" });
const sp = mem.memorySystemPrompt();
assert(sp.includes("已截断") && sp.length < 3000, "超长记忆截断注入");

console.log("全部通过 ✅");
