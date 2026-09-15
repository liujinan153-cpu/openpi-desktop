// P53 git-checkpoint 单元测试（直测模块，无需 Electron）
// 运行：node scripts/unit-p53.mjs
const git = require("../src/main/git-checkpoint.mjs");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const ID = ["-c", "user.name=T", "-c", "user.email=t@t.local"];
const assert = (c, m) => { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✅ " + m); };
const root = path.join(os.tmpdir(), "p53-unit");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const mk = (n) => { const d = path.join(root, n); fs.mkdirSync(d); return d; };
const gitc = git;

// ===== 场景1：正常仓库（有 HEAD）=====
const s1 = mk("s1");
process.chdir(s1);
gitc.setGitWorkspace(s1);
execFileSync("git", ["init", "-q", "-b", "main"]);
fs.writeFileSync("a.txt", "hello\n");
execFileSync("git", ["add", "-A"]);
execFileSync("git", [...ID, "commit", "-m", "init", "--no-verify"]);

// 模拟 AI 第一轮改动（未提交）
fs.writeFileSync("a.txt", "hello v1.5\n");
assert(git.autoCheckpointIfNeeded(null, "write a.txt v1.5"), "有未提交变更→建快照");
assert(!git.autoCheckpointIfNeeded(null, "30s 节流"), "30s 内→节流跳过");

// 模拟 AI 第二轮改动
fs.writeFileSync("a.txt", "hello v2\n");
fs.writeFileSync("b-new.txt", "new\n");
const d = git.diffVs(s1, "refs/openpi/checkpoints");
assert(d.ok && d.diff.includes("hello v1.5") && d.diff.includes("hello v2"), "git_diff 对照快照显示两版差异");
const d2 = JSON.stringify(git.gitTools[1].execute("t", {}, undefined, undefined, {}));
assert(d2.includes("hello v2"), "git_diff 工具层工作");

// 回滚到快照 = 回到 v1.5（第一轮改动后、第二轮改动前）
const rb = JSON.stringify(git.gitTools[2].execute("t", {}, undefined, undefined, {}));
assert(rb.includes("已回滚到检查点"), "git_rollback 工具层成功");
const back = fs.readFileSync("a.txt", "utf8").replace(/\r\n/g, "\n");
assert(back === "hello v1.5\n", "a.txt 恢复到 v1.5: " + JSON.stringify(back));
assert(!fs.existsSync("b-new.txt"), "快照后新增文件已被删除");
assert(git.listCheckpoints(s1).length === 1, "回滚后检查点历史保留");
const st4 = JSON.stringify(git.gitTools[0].execute("t", {}, undefined, undefined, {}));
assert(st4.includes("openpi:checkpoint"), "git_status 列出检查点");

// ===== 场景2：无 HEAD 的全新仓库 =====
const s2 = mk("s2");
process.chdir(s2);
gitc.setGitWorkspace(s2);
execFileSync("git", ["init", "-q", "-b", "main"]);
fs.writeFileSync("x.txt", "x\n");
const r2 = git.createCheckpoint(s2, "无 HEAD 首快照");
assert(!r2.skipped && r2.id, "无 HEAD 也能建快照");
assert(execFileSync("git", ["ls-files"], { cwd: s2, encoding: "utf8" }).includes("x.txt"), "无 HEAD 快照后 index 不被清空");
assert(fs.existsSync(path.join(s2, "x.txt")), "无 HEAD 快照不破坏工作区");

// ===== 场景3：干净仓库（无变更）也建基线快照 =====
const s3 = mk("s3");
process.chdir(s3);
gitc.setGitWorkspace(s3);
execFileSync("git", ["init", "-q", "-b", "main"]);
fs.writeFileSync("base.txt", "base\n");
execFileSync("git", ["add", "-A"]);
execFileSync("git", [...ID, "commit", "-m", "init", "--no-verify"]);
const r3 = git.createCheckpoint(s3, "干净基线");
assert(!r3.skipped && r3.id, "干净仓库也建基线快照（首写可撤销）");
fs.writeFileSync("new1.txt", "n\n"); // 首写
const rb3 = git.rollbackTo(s3);
assert(rb3.ok && !fs.existsSync(path.join(s3, "new1.txt")), "首写文件可回滚撤销");

// ===== 场景4：非 git 目录 =====
const s4 = mk("s4");
process.chdir(s4);
gitc.setGitWorkspace(s4);
fs.writeFileSync("y.txt", "y");
assert(git.createCheckpoint(s4, "x").skipped, "非 git 目录 skipped 不报错");
const st3 = JSON.stringify(git.gitTools[0].execute("t", {}, undefined, undefined, {}));
assert(st3.includes("不是 git 仓库"), "git_status 非 git 目录友好报错");
assert(git.checkpointSystemPrompt() === "", "非 git 目录不注入系统提示");

// ===== 场景5：系统提示注入（git 仓库）=====
gitc.setGitWorkspace(s1);
assert(git.checkpointSystemPrompt().includes("git_diff"), "git 仓库注入提示词");
assert(git.verificationSystemPrompt().includes("node --check"), "P54 验证闭环提示注入（git 仓库）");
console.log("\n全部通过 ✅");
