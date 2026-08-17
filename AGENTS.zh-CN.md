# AGENTS.zh-CN.md — dsh-kernel-grok 维护者文档

本文档面向 `dsh-kernel-grok` 的维护者，记录 schema 出处、每项实现决策、已知缺口以及测试
方法。面向用户的 `README.md` 是简版；本文是完整的工程记录。

## 概览

`dsh-kernel-grok` 是一个零依赖的单文件 DSH（DeepSeek Harness）插件。它唯一的职责是：把
**grok-build 工具面**重新注册为 DSH 工具，沿用 grok 原生的 snake_case 名称、schema 与语
义，但直接实现在 DSH 服务（`fs`、`web`、`subprocess`、`jobs`、`subagents`、`planMode`、
`userQuestions`）之上，因此该工具面不依赖真实的 grok CLI，且在 `toolFilter` 裁剪下依然存活。

插件是一个 Cordis 插件对象：

```js
export const name = 'dsh-kernel-grok'
export const inject = ['fs', 'tools', 'subprocess', 'web', 'jobs']
export async function apply(ctx) { /* 注册全部工具 */ }
```

`inject` 是 Cordis 的**硬依赖屏障**（mesh AGENTS.md §2）：Cordis 会等到每个声明的服务就绪后
才调用 `apply()`。只有插件无法启动时缺少的服务——`fs`、`tools`、`subprocess`、`web`、
`jobs`——才应列入。可选服务（`subagents`、`planMode`、`sandboxPolicy`、`userQuestions`、
`systemPrompt`）通过 `ctx.get(...)` 读取并对 `undefined` 做防护。切勿把未在 `inject` 中声明
的服务当作裸的 `ctx.<name>` 属性读取。若 `tools` 或 `fs` 缺失，插件会提前返回、不注册任何
内容。所有注册（`tools.register`、`systemPrompt.section`）都在 `apply()` 内绑定到 fiber；
没有超出 `apply()` 生命周期的模块级副作用。

## Schema 出处

每个工具的 `name`、`description` 与 `parameters` 对象，都忠实地提炼自 grok-build 在
`xai-org/grok-build` 仓库中的对应工具定义，具体是
`crates/codegen/xai-grok-tools/src/implementations/` 下的 Rust 源码。对应关系：

| DSH 工具             | grok-build 源文件 |
|----------------------|-------------------|
| `run_terminal_cmd`   | `bash/mod.rs`（`BashToolInput`） |
| `read_file`          | `read_file/mod.rs`（`ReadFileInput`） |
| `search_replace`     | `search_replace/mod.rs`（`SearchReplaceInput`） |
| `list_dir`           | `list_dir/mod.rs`（`ListDirInput`） |
| `grep`               | `grep/mod.rs`（`GrepSearchInput`） |
| `web_search`         | `web_search/mod.rs`（`WebSearchInput`） |
| `web_fetch`          | `web_fetch/mod.rs`（`WebFetchInput`） |
| `todo_write`         | `todo/mod.rs`（`TodoWriteInput`） |
| `get_task_output`    | `task_output`（`TaskOutputToolInput`） |
| `kill_task`          | `kill_task/mod.rs`（`KillTaskToolInput`） |
| `ask_user_question`  | `AskUserQuestionInput` |
| `task`               | `task/mod.rs`（`TaskToolInput` → `TaskTool`） |
| `enter_plan_mode` / `exit_plan_mode` | 计划模式对 |

两个承载语义的关键细节直接来自 grok，并被逐字保留：

1. **`search_replace` 就是 grok 的写入工具。** grok-build 没有单独的 `write_file`；创建新文
   件就是令 `old_string` 为空字符串。`index.js` 中的 `description` 明确记录了这一点。DSH 的
   `editText` 会拒绝空 `oldString`，因此该路径走无条件的 `fs.writeText`；非空 `old_string`
   仍走 `fs.editText`。
2. **`run_terminal_cmd` 要求 `description`。** 其 `required` 数组为
   `['command', 'description']`，描述必须说明为何需要该命令。这是 grok 的原生约束，而非
   DSH 的任意附加。

## 名称冲突兜底

grok 的 snake_case 名称与 DSH 自身的工具重叠：`grep`、`web_search`、`todo_write`、
`ask_user_question`（以及 `exit_plan_mode`）。grok-kernel 预设会禁用冲突的 DSH 行
（`tool-fs-search`、`tool-web`、`tool-todo`、`tool-ask-user`），但预设编辑与 DSH 行的加载顺序
在每个部署中并不保证一致。因此每次注册都经过 `register()` 辅助函数：

```js
const register = (t) => {
  try { tools['register'](t) } catch (e) {
    console.warn('[dsh-kernel-grok] skipping tool "' + t.name + '": ' + String(e))
  }
}
```

这个 try/catch 兜底是**与顺序无关**的：如果 DSH 已经占据某个名称并拒绝重新注册，工具会被
跳过并发出警告，而不是让 `apply()` 崩溃。预设禁用冲突行仍是首选修复方案；兜底只是在预设与
运行时不一致时让插件保持健壮。

## 实现决策

- **`run_terminal_cmd`** 通过 `subprocess.spawn` 运行 PowerShell。`pwsh.exe` 在 try/catch 中
  用 `subprocess.resolveExecutable('pwsh.exe', ...)` 解析，解析失败时回退到绝对路径
  `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`（见项目 README 中的 ENOENT
  缺陷历史）。`is_background=true` 时把 spawn 句柄包进一个 `jobs.start` 的 shell 任务，以便
  `get_task_output` 与 `kill_task` 管理；否则命令运行到结束，返回 stdout + stderr 与
  `[exit code: N]` 尾缀。
- **`read_file`** 用 `fs.resolve` 解析路径、用 `fs.readText` 读取，按 `\r?\n` 分行，并以与
  grok 一致的负偏移语义应用 offset/limit（负 `offset` 从末尾倒计数）。
- **`search_replace`** 调用 `fs.editText` 并传 `{ oldString, newString, replaceAll }`，显式把
  `sandboxPolicy.resolve()` 结果作为第五个参数传入，以尊重沙箱策略（即项目 README 中的沙箱
  误拒缺陷）。
- **`list_dir`** 在 `fs.listDir` 上实现有界的递归遍历（最多 2000 条、最深 8 层），而不依赖
  任何 shell 的 `ls`，从而让输出形态匹配 grok 对目录使用尾斜杠的惯例。
- **`grep`** 使用**自有正则遍历**，既不用 DSH 的 `grep` 工具，也不用 `subprocess` 的
  ripgrep：复用共享的 `walk()` 辅助函数枚举文件（跳过 `node_modules`、`.git`、`.grok`、
  `.venv`、`__pycache__`、`dist`、`target`），跳过大于 512 KiB 的文件，并按行应用模式。glob
  过滤使用手写的 `globToRegex`（支持 `*`、`**`、`?` 与 `{a,b}`），`type` 是尽力而为的扩展名
  过滤。
- **`web_search` / `web_fetch` 优先走 grok-build 自己的 wire。** `web_search` 用
  `~/.grok/auth.json` 里的 Grok OAuth JWT，加上与 `dsh-kernel-mesh` 相同的五个
  CLI-proxy header，POST 到 `https://cli-chat-proxy.grok.com/v1/responses`，
  `tools: [{ type: 'web_search' }]`（`allowed_domains` 作为
  `filters.allowed_domains` 转发）。`web_fetch` 经 `$HTTPS_PROXY` /
  `http://127.0.0.1:7897` 做本地 HTTPS GET（HTTP 会升级），对齐 grok-build 的
  客户端抓取。只有 OAuth 文件缺失或原生调用失败时才回退 `ctx.web`。
- **`get_task_output` / `kill_task`** 使用 DSH 的 `jobs` 服务（`jobs.wait`、`jobs.read`、
  `jobs.kill`）。`get_task_output` 仅当 `timeout_ms > 0` 时等待，上限 600000 毫秒。
- **`ask_user_question`** 使用 DSH 的 `userQuestions` 服务（`userQuestions.ask`），把 grok 的
  `multi_select` 转成服务的 `multiSelect`。服务不可用时优雅降级：告诉调用方在回复文本中重述
  这些问题。
- **`todo_write`** 维护一个**按 agent id 键控的插件本地 `Map`**（而非 DSH 的 todo 服务）。
  `merge=true`（默认）按 `id` 合并入站条目——仅状态更新可省略 `content`——`merge=false` 则整体
  替换列表。这匹配了 grok 按 id 合并的语义，同时不耦合到 DSH 自己的 todo 服务（该服务反正
  已被 grok 预设禁用）。
- **`task` 对齐原生 `subagent` 工具。** 后台为默认（`run_in_background !== false` →
  `subagents.startContinuable`），在收件箱受理时返回持久子代理 id。`resume` 通过
  `subagents.followup` 投递 `prompt`（与 `send_message` 同一通道）。前台
  （`run_in_background: false`）等待 `subagents.start`，并在非 `completed` 停止时追加
  `"Partial output before the run ended:"` 与子代理已产出的文本——与原生措辞一致。每个
  请求都显式设置 `agentOptions` / `persona` / `toolFilter` / `maxDepth: 3`，因为可续接
  路由从不调用 `provider.start()`。工具声明 `isConcurrencySafe: () => true`，并注册
  `systemPrompt` 段落（`tool:task`，order `116.5`），在工具可见时教导后台优先约定。
  provider 优先选 `grok-agent` / `grok-explore`（若已列出），否则回退 `spawn`。
- **`enter_plan_mode` / `exit_plan_mode`** 使用 `planMode` 服务
  （`planMode.set(agent, true/false)`），且仅在 `planMode` 存在时才注册。

## DSH 的 ToolDefinition 契约

DSH 工具对象需要 `name`、`description`、一个 JSON-Schema 形状的 `parameters` 对象、
`output: { schema, render }`，以及一个 `execute(args, exec)` 函数（mesh AGENTS.md §3.4）。
`strDef(t)` 辅助函数挂接一个共享的 `output` 描述符
（`{ schema: { type: 'string' }, render }`），把字符串结果渲染为纯文本、其余结果做
JSON 序列化——每次注册都同时具备 `schema` 与 `render`；不要伪造 schema 未声明的结果字段。
`execute` 收到 `(args, exec)`：`args` 是校验后的工具参数，`exec` 携带 `exec.agent` 与
`exec.signal`；每个实现都把 `exec.signal` 传入底层的异步服务调用，以使取消得以传播。
具体的注册入口是 DSH `tools` 服务的 `register` 方法。

## 已知缺口

- **`grep` 的 `-B` / `-A` / `-C` 仅尽力而为。** schema 接受这些上下文标志，但自有遍历实现只
  返回匹配行、不带前后文。grok 自己的实现（基于 ripgrep）会输出上下文字行。
- **`type` 过滤仅尽力而为。** 它是把文件扩展名小写后与参数比较，而非使用真实的 ripgrep 类型
  表。
- **`web_search` 的 `allowed_domains` 会转发给 grok CLI 代理。** DeepSeek 的
  `ctx.web` 回退路径仍然无法兑现该过滤。
- ~~**`task` 的 `run_in_background` 以前台方式运行。**~~ **已解决**（mesh 缺口 #5）。`task`
  现在以后台优先走原生可续接路由（`subagents.startContinuable`）：省略 `run_in_background`
  （或设为 true）即返回持久子代理 id，`list_agents` / `send_message` / `interrupt_agent` /
  `task.resume` 均可操作，与原生 `subagent` 工具一致。仅在下一步必须等待一次性结果时
  才设 `run_in_background: false`。见上文 `task` 实现说明。
- **`exit_plan_mode` 的计划呈现留给 DSH 自身机制。** 工具只翻转 `planMode` 标志并指示模型在
  回复文本中呈现计划；它本身不渲染计划 UI。
- **部分工具上的 `header` 及尽力而为字段**（`ask_user_question` 的 `header`、`grep` 的上下文
  标志）为保 schema 一致而被接受，但可能未被完整兑现。

### 本工具面曾经继承、现已在上游解决的 mesh 缺口

这些记录在 `dsh-kernel-mesh`，**不是**本包的待办：

- ~~**Mesh 缺口 #5 —— 可续接子代理路由。**~~ **已在 mesh 解决**；本包的 `task` 把它作为
  默认路由使用（见上）。
- ~~**Mesh 缺口 #6 —— 非流式传输。**~~ **已在 mesh 解决**：两条 adapter 工厂现在真正流式
  传输 SSE（`stream: true`、curl `-N`），并在提供方忽略流式时自动回退到 JSON。本工具面
  自身没有传输层。
- ~~**未分类的 adapter 错误。**~~ **已在 mesh 解决**：adapter 以规范的自有属性码
  （`e.code` + `e.failure`）抛出，因此 `dsh-llm-retry` 会重试 `RATE_LIMIT` / `SERVER` /
  `TIMEOUT` / `TRANSPORT`。本工具面不抛出 adapter 错误。

## 测试说明

- **语法：** `node --check lib/index.js` 是最快的冒烟测试，每次改动后都应运行；该文件是纯
  ESM（`type: module`）、无构建步骤。
- **注册冒烟测试：** 在一个冲突 DSH 行**仍启用**的 DSH profile 下加载插件，确认
  `console.warn` 兜底会触发且插件仍能应用。再在 grok-kernel 预设（冲突行已禁用）下加载，确
  认全部 15 个工具无警告地注册成功。
- **功能检查**（最好通过使用 grok-kernel 预设的 agent 会话进行）：`list_dir` 对目录返回尾斜
  杠名称；`search_replace` 传空 `old_string` 时创建文件、传普通 `old_string` 时原地修改；
  `run_terminal_cmd` 传 `is_background=true` 时返回一个 `get_task_output` 可读、`kill_task`
  可停的任务 id；`task` 默认返回持久后台子代理 id，`resume` 会排队后续回合，
  `run_in_background: false` 且 `subagent_type: 'explore'` 时返回子代理的文本块
  （非 `completed` 停止时带 `"Partial output before the run ended:"`）。
- **沙箱：** 确认 `search_replace` 写入成功，因为 `sandboxPolicy.resolve()` 被透传给了
  `fs.editText`。

## 目录结构

```
dsh-kernel-grok/
  lib/index.js      # 整个插件（单文件 ESM Cordis 插件）
  package.json      # type:module + exports/files/scripts.test（DSH 插件契约）
  LICENSE           # MIT，Copyright (c) 2026 oppnc
  README.md         # 面向用户的简短英文文档
  README.zh.md      # 中文翻译
  README.i18n.yaml  # 双语配对的 git blob hash
  AGENTS.md         # 本文件
  AGENTS.zh-CN.md   # 本文件的中文翻译
```
