/**
 * P53b 工作区 Git Checkpoint（0.43.0）
 *
 * 设计：
 * - 快照用 `git write-tree` + `git commit-tree` 构造独立提交对象，**不动 HEAD、不污染用户分支历史**；
 *   提交链挂在自定义 ref `refs/openpi/checkpoints`（`git log refs/openpi/checkpoints` 即快照历史，
 *   ref 持有对象不会被 gc）。
 * - 挂点：approvalExtension 的 tool_call 放行前（写类操作执行**前**快照），
 *   回滚 = 恢复到该次改动之前；同轮多次写操作按 30s 节流复用上一个快照。
 * - 回滚（git_rollback）为危险操作：read-tree + checkout-index 覆盖 + clean 删快照后新增文件，
 *   不在 READ_ONLY_TOOLS 中 → 自动落入审批弹窗。
 * - 已知副作用：快照瞬间会 `git add -A` 再 `git reset` 还原 index，
 *   用户此前手动 staged 的内容会被取消 staged（工作区文件不动）。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const GIT_TIMEOUT = 15000;
/** 同轮节流：距上次快照小于该秒数则复用（避免一轮改 10 个文件打 10 个快照） */
const THROTTLE_MS = 30_000;

/**
 * P53 工作目录注入：工具 execute 与自动快照共用。
 * worker 进程 cwd 是主进程安装目录，SDK ctx.cwd 也不可靠（e2e 实测=进程 cwd），
 * 故由 agent-host 在 createAgentSession 前显式注入 workspace。
 */
let _workspace = null;
export function setGitWorkspace(ws) {
	_workspace = ws;
	console.error("[p53] 检查点工作目录:", ws);
}
const cwdOf = (_ctx) => _workspace || process.cwd();

function git(cwd, args, allowFail = false) {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			timeout: GIT_TIMEOUT,
			windowsHide: true,
			maxBuffer: 16 * 1024 * 1024,
		}).trim();
	} catch (err) {
		if (allowFail) return "";
		throw err;
	}
}

/** 快照提交统一身份（用户机器可能未配 git 身份；快照独立于用户提交历史，覆盖无妨） */
const IDENTITY = ["-c", "user.name=OpenPi Checkpoint", "-c", "user.email=checkpoint@openpi.local"];

export function isGitRepo(cwd) {
	return Boolean(git(cwd, ["rev-parse", "--git-dir"], true));
}

/** 最近一次快照 commit id；无则空串 */
export function lastCheckpointId(cwd) {
	return git(cwd, ["rev-parse", "--verify", "-q", "refs/openpi/checkpoints"], true);
}

/**
 * 创建快照。返回 { id, skipped }；非 git 仓库 / 无任何变更时 skipped=true。
 */
export function createCheckpoint(cwd, label) {
	if (!isGitRepo(cwd)) return { id: "", skipped: true };
	try {
		// 无论是否有变更都建快照：干净状态也打「基线快照」，保证首写文件也可撤销
		//（若直接跳过，首次 write 前无快照，回滚时报「没有可用的检查点」）
		git(cwd, ["add", "-A"]);
		const tree = git(cwd, ["write-tree"]);
		const last = lastCheckpointId(cwd);
		let head = git(cwd, ["rev-parse", "--verify", "-q", "HEAD"], true);
		// 提交链：后续快照挂上一快照；首个快照挂 HEAD（保留与用户历史的血缘）
		const parents = last ? ["-p", last] : head ? ["-p", head] : [];
		const id = git(cwd, [...IDENTITY, "commit-tree", tree, ...parents, "-m", `openpi:checkpoint ${label}`]);
		git(cwd, ["update-ref", "refs/openpi/checkpoints", id]);
		if (head) git(cwd, ["reset", "-q"]); // 还原 index（unstage add -A）；无 HEAD 时 reset 会清空 index，必须跳过
		return { id, skipped: false };
	} catch {
		return { id: "", skipped: true }; // 快照失败不阻断主流程（与审计日志同策略）
	}
}

/** 快照列表（新→旧），供 git_status / AI 感知 */
export function listCheckpoints(cwd, limit = 10) {
	if (!isGitRepo(cwd) || !lastCheckpointId(cwd)) return [];
	const out = git(
		cwd,
		// 首个快照挂了 HEAD 历史，必须 --grep 过滤只留 openpi 快照
		["log", "--oneline", "--no-decorate", "--grep=openpi:checkpoint", `-n${limit}`, "refs/openpi/checkpoints"],
		true
	);
	return out ? out.split("\n").filter(Boolean) : [];
}

/** 回滚工作区到指定快照（默认最近）。返回 { ok, error } */
export function rollbackTo(cwd, ref = "refs/openpi/checkpoints") {
	const id = git(cwd, ["rev-parse", "--verify", "-q", ref], true);
	if (!id) return { ok: false, error: "没有可用的检查点。" };
	try {
		git(cwd, ["read-tree", id]);
		git(cwd, ["checkout-index", "-af"]);
		git(cwd, ["clean", "-fd"]);
		// index 已指到快照树，还原 index 到 HEAD（保持常规 git 视角）
		if (git(cwd, ["rev-parse", "--verify", "-q", "HEAD"], true)) git(cwd, ["reset", "-q"]);
		return { ok: true, id };
	} catch (err) {
		return { ok: false, error: String(err?.message ?? err).slice(0, 300) };
	}
}

/** 工作区对照快照/HEAD 的 diff（截断防爆屏） */
export function diffVs(cwd, ref = "HEAD") {
	if (!isGitRepo(cwd)) return { ok: false, error: "当前工作区不是 git 仓库。" };
	try {
		const out = git(cwd, ["diff", ref]);
		return { ok: true, diff: out.length > 60_000 ? out.slice(0, 60_000) + "\n…（已截断）" : out };
	} catch (err) {
		return { ok: false, error: String(err?.message ?? err).slice(0, 300) };
	}
}

export const gitTools = [
	{
		name: "git_status",
		label: "Git 状态",
		description:
			"查看当前工作区 git 状态：变更文件列表 + OpenPi 检查点历史（新→旧）。只读，不需要用户确认。",
		parameters: {},
		execute(_id) {
			const cwd = cwdOf();
			if (!isGitRepo(cwd)) {
				return { content: [{ type: "text", text: "当前工作区不是 git 仓库（OpenPi 检查点功能不可用，可让用户初始化 git）。" }], details: { ok: false } };
			}
			const changes = git(cwd, ["status", "--porcelain"], true);
			const cps = listCheckpoints(cwd);
			return {
				content: [{ type: "text", text: `变更：\n${changes || "（工作区干净，无未提交变更）"}\n\n检查点（新→旧）：\n${cps.length ? cps.join("\n") : "（暂无 OpenPi 检查点）"}` }],
				details: { ok: true },
			};
		},
	},
	{
		name: "git_diff",
		label: "Git 差异",
		description:
			"查看代码差异（改动证据）：默认对照 HEAD；传 checkpoint=true 对照最近一次 OpenPi 检查点。只读。",
		parameters: { type: "object", properties: { checkpoint: { type: "boolean" } } },
		execute(_id, params = {}) {
			const cwd = cwdOf();
			const ref = params.checkpoint ? "refs/openpi/checkpoints" : "HEAD";
			const r = diffVs(cwd, ref);
			return { content: [{ type: "text", text: r.ok ? `对照 ${ref}：\n${r.diff || "（无差异）"}` : `git_diff 失败：${r.error}` }], details: { ok: r.ok } };
		},
	},
	{
		name: "git_rollback",
		label: "Git 回滚",
		description:
			"把工作区回滚到指定检查点（默认最近一次）。⚠ 危险：会覆盖未提交修改并删除检查点之后新建的文件，需要用户确认。传 checkpoint=<id 或 refs/openpi/checkpoints 可用值> 指定目标。",
		parameters: {
			type: "object",
			properties: { checkpoint: { type: "string", description: "快照 id（git_status 里查）" } },
		},
		execute(_id, params = {}) {
			const cwd = cwdOf();
			const ref = params.checkpoint || "refs/openpi/checkpoints";
			const r = rollbackTo(cwd, ref);
			return { content: [{ type: "text", text: r.ok ? `已回滚到检查点 ${r.id}` : `回滚失败：${r.error}` }], details: { ok: r.ok } };
		},
	},
];

/** 写类工具放行前的自动快照（30s 节流）。cwd 传 null 用注入的 workspace。返回是否新建了快照 */
let _lastSnap = 0;
export function autoCheckpointIfNeeded(cwd, label) {
	const now = Date.now();
	if (now - _lastSnap < THROTTLE_MS) return false;
	_lastSnap = now;
	const r = createCheckpoint(cwd || _workspace, label);
	return !r.skipped;
}

/** P53b：主会话注入的提示词段落（仅 git 仓库时） */
/**
 * P54 验证闭环：系统提示约定——改动代码后必须跑测试/构建并贴证据，跑不了要说明原因。
 * 与检查点提示同一注入点（before_agent_start），git 仓库工作区才注入（避免普通聊天噪音）。
 */
export function verificationSystemPrompt() {
	const cwd = _workspace;
	if (!cwd || !isGitRepo(cwd)) return "";
	return (
		"\n\n## 验证闭环（自我验证，始终生效）\n" +
		"改动代码的任务，在向用户汇报「完成」之前必须先自证：\n" +
		"1. 优先跑项目已有的测试/构建命令（npm test / pytest / tsc --noEmit 等，从 package.json 或项目文件里发现）；\n" +
		"2. 没有测试就写最小验证：对改动的 JS 文件跑 node --check 语法检查，或写一个一次性脚本实际运行新函数；\n" +
		"3. 汇报时附上验证命令与输出摘录作为证据（例：`node --check src/lib.js` → 无输出即语法 OK）；\n" +
		"4. 确实无法验证（缺依赖/缺环境）时，明确说明原因和你尝试过什么，不要静默跳过。\n"
	);
}

/**
 * 注入点：非 plan 档位拼装检查点 + 验证闭环提示（P53 + P54）。
 */
export function selfCheckPrompts() {
	return checkpointSystemPrompt() + verificationSystemPrompt();
}

export function checkpointSystemPrompt() {
	const cwd = _workspace;
	if (!cwd) return "";
	if (!isGitRepo(cwd)) return "";
	const cps = listCheckpoints(cwd, 3);
	return (
		"\n\n## Git 检查点（OpenPi 自动快照）\n" +
		"本工作区是 git 仓库，OpenPi 在每次写操作前自动创建检查点（refs/openpi/checkpoints，不动你的分支历史）。\n" +
		"可用工具：git_status（变更+检查点列表）、git_diff（改动证据，建议改完代码后主动查看并汇报）、git_rollback（回滚，需用户确认）。\n" +
		"修改代码后请用 git_diff 核对实际改动再向用户汇报——「改好了」要附上证据。\n" +
		(cps.length ? `最近检查点：${cps.join("；")}\n` : "")
	);
}
