# AGENTS.md — Maintainer documentation for dsh-kernel-grok

This document is for maintainers of `dsh-kernel-grok`. It records schema provenance, every
implementation decision, the known gaps, and how to test. The human-facing `README.md` is the
short version; this file is the complete engineering record.

## Overview

`dsh-kernel-grok` is a single DSH (DeepSeek Harness) plugin with no dependencies. Its one job is
to re-register the **grok-build tool surface** as DSH tools, using grok's native snake_case
names, schemas, and semantics, but implemented directly on DSH services (`fs`, `web`,
`subprocess`, `jobs`, `subagents`, `planMode`, `userQuestions`) so the surface does not depend on
the real grok CLI and survives `toolFilter` scoping.

The plugin is a Cordis plugin object:

```js
export const name = 'dsh-kernel-grok'
export const inject = ['fs', 'tools', 'subprocess', 'web', 'jobs']
export async function apply(ctx) { /* registers every tool */ }
```

`inject` is the Cordis **hard-dependency barrier** (mesh AGENTS.md §2): Cordis will not
call `apply()` until every listed service is ready. Only services the plugin cannot start
without — `fs`, `tools`, `subprocess`, `web`, `jobs` — belong there. Optional services
(`subagents`, `planMode`, `sandboxPolicy`, `userQuestions`, `systemPrompt`) are read with
`ctx.get(...)` and guarded against `undefined`. Never read an undeclared service as a bare
`ctx.<name>` property. If `tools` or `fs` is missing the plugin returns early and registers
nothing. Every registration (`tools.register`, `systemPrompt.section`) is fiber-scoped
inside `apply()`; there are no module-level side effects.

### Mesh dependency and fallback mount

`dsh-kernel-mesh` is a declared dependency (`github:oppnc/dsh-kernel-mesh#semver:^0.1.7`),
so installing this package also installs the mesh. The mesh is still expected to be mounted
ONCE by the host composition (profile bundle) and shared by all vendor packages. As a
safety net, `apply()` first runs `ensureKernelMesh(ctx, ...)` (`lib/ensure-mesh.js`): if
the mesh's `kernelMesh` marker service is absent AND no `*-kernel` route is registered,
the plugin mounts its own copy of the mesh (bare specifier, with a dev-layout sibling
fallback). A fallback-mounted mesh shares THIS row's lifecycle — its routes disappear
when the row unloads — so the profile-level mount stays the preferred form and the
fallback logs a pointer to `dsh plugin add dsh-kernel-mesh`.

## System prompt (persona)

`lib/system-prompt.js` carries the upstream **Grok Build** system prompt, rewritten in DSH
form: tool names and runtime placeholders are adapted to the DSH tool surface, while the
behavior rules are kept verbatim. Upstream source: https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-agent/templates/prompt.md

`apply()` registers it as the `deployment:persona` section (order `0`) with
`complete: true`, and calls `systemPrompt.suppressRuntimeContext()`. Together these make
the vendor prompt the **sole** system-prompt section and drop the runtime-context snapshot,
so a session on this kernel sees ONLY the vendor's own system prompt.

Consequence for presets: a preset that mounts this plugin MUST NOT also mount a
`@deepseek-ai/dsh-persona` row — both register `deployment:persona` in the same scope and
the second registration throws. The kernel presets ship without that row.

## Schema provenance

Every tool's `name`, `description`, and `parameters` object is a faithful distillation of the
corresponding grok-build tool definition in the `xai-org/grok-build` repository, specifically the
Rust source under `crates/codegen/xai-grok-tools/src/implementations/`. The mapping is:

| DSH tool             | grok-build source file |
|----------------------|------------------------|
| `run_terminal_cmd`   | `bash/mod.rs` (`BashToolInput`) |
| `read_file`          | `read_file/mod.rs` (`ReadFileInput`) |
| `search_replace`     | `search_replace/mod.rs` (`SearchReplaceInput`) |
| `list_dir`           | `list_dir/mod.rs` (`ListDirInput`) |
| `grep`               | `grep/mod.rs` (`GrepSearchInput`) |
| `web_search`         | `web_search/mod.rs` (`WebSearchInput`) |
| `web_fetch`          | `web_fetch/mod.rs` (`WebFetchInput`) |
| `todo_write`         | `todo/mod.rs` (`TodoWriteInput`) |
| `get_task_output`    | `task_output` (`TaskOutputToolInput`) |
| `kill_task`          | `kill_task/mod.rs` (`KillTaskToolInput`) |
| `ask_user_question`  | `AskUserQuestionInput` |
| `task`               | `task/mod.rs` (`TaskToolInput` → `TaskTool`) |
| `enter_plan_mode` / `exit_plan_mode` | plan-mode pair |

**Re-checked against grok-build `e5fd481..origin/main` (2026-08 sync, 12 "Synced from
monorepo" commits).** Findings: every existing tool's name/description/schema is unchanged
(all in-range hunks are test-only assertion loosening); `prompt.md` and the subagent persona
prompts are byte-identical. Actionable deltas applied:

- `x-grok-client-version` bumped `1.0.3` → `1.0.12` (tracks
  `crates/codegen/xai-grok-version/Cargo.toml`; also in the mesh's grok adapter).
- Upstream removed `capability_mode` from the model-facing `task` schema
  (`#[schemars(skip)]`); this plugin never advertised it.
- Upstream added `send_subagent_message` (`subagent_id` + `text`, maps to DSH
  `send_message`) but ships it **feature-gated and off by default** — not registered here;
  `task.resume` already covers the follow-up channel.
- Upstream's `workflow` tool input was restructured (`source` tagged enum); this plugin
  does not expose a workflow tool.
- Subagent wiring: upstream now strips `ask_user_question` (and the workflow tool) from
  every subagent — mirrored in `lib/subagents.js` (the `grok-agent` allow-list omits
  `ask_user_question`).
- Model catalog: `grok-4.6` is the new default (500K context, `supports_backend_search`,
  `system_prompt_label: "Grok 4.6"`) and advertises effort `xhigh` above `high`; the mesh
  grok adapter passes `xhigh` through verbatim and collapses only `max` → `xhigh`.

Two semantic load-bearing details come straight from grok and are preserved verbatim:

1. **`search_replace` IS grok's write tool.** grok-build has no separate `write_file`;
   creating a new file is `old_string` set to the empty string. The `description` in
   `index.js` documents this explicitly. DSH `editText` rejects an empty `oldString`, so
   that path is an unconditional `fs.writeText`; a non-empty `old_string` still goes
   through `fs.editText`.
2. **`run_terminal_cmd` requires `description`.** Its `required` array is
   `['command', 'description']`, and the description must state why the command is needed. This
   is grok's native constraint, not an arbitrary DSH addition.

## Name-collision backstop

grok's snake_case names overlap with DSH's own tools: `grep`, `web_search`, `todo_write`, and
`ask_user_question` (and `exit_plan_mode`). The grok-kernel preset disables the colliding DSH
rows (`tool-fs-search`, `tool-web`, `tool-todo`, `tool-ask-user`), but preset editing and DSH row
load order are not guaranteed to line up in every deployment. So every registration goes through
a `register()` helper:

```js
const register = (t) => {
  try { tools['register'](t) } catch (e) {
    console.warn('[dsh-kernel-grok] skipping tool "' + t.name + '": ' + String(e))
  }
}
```

This try/catch backstop is **ordering-independent**: if DSH has already claimed a name and
rejects the re-registration, the tool is skipped with a warning rather than crashing
`apply()`. The preset disabling the colliding rows is still the preferred fix; the backstop only
keeps the plugin resilient when the preset and the runtime disagree.

## Implementation decisions

- **`run_terminal_cmd`** runs PowerShell via `subprocess.spawn`. `pwsh.exe` is resolved with
  `subprocess.resolveExecutable('pwsh.exe', ...)` inside a try/catch, falling back to the
  absolute `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` when resolution fails
  (see the ENOENT bug history in the project README). `is_background=true` wraps the spawn
  handle in a `jobs.start` shell job so `get_task_output` and `kill_task` can manage it;
  otherwise the command runs to completion and returns stdout + stderr + an `[exit code: N]`
  trailer.
- **`read_file`** resolves the path with `fs.resolve`, reads with `fs.readText`, splits on
  `\r?\n`, and applies offset/limit with the same negative-offset semantics as grok (negative
  `offset` counts back from the end).
- **`search_replace`** calls `fs.editText` with `{ oldString, newString, replaceAll }`, passing
  the `sandboxPolicy.resolve()` result explicitly as the fifth argument so sandbox policy is
  honored (the sandbox-misrejection bug from the project README).
- **`list_dir`** implements a bounded recursive walk over `fs.listDir` (max 2000 entries, max
  depth 8) rather than relying on any shell `ls`, so the output shape matches grok's
  trailing-slash convention for directories.
- **`grep`** uses an **own regex walk**, not DSH's `grep` tool and not `subprocess` ripgrep: it
  reuses the shared `walk()` helper to enumerate files (skipping `node_modules`, `.git`, `.grok`,
  `.venv`, `__pycache__`, `dist`, `target`), skips files larger than 512 KiB, and applies the
  pattern line-by-line. Glob filtering uses a hand-rolled `globToRegex` (supports `*`, `**`, `?`,
  and `{a,b}`), and `type` is a best-effort extension filter.
- **`web_search` / `web_fetch` prefer grok-build's own wire.** `web_search`
  POSTs to `https://cli-chat-proxy.grok.com/v1/responses` with the Grok OAuth
  JWT from `~/.grok/auth.json`, the same five CLI-proxy headers as
  `dsh-kernel-mesh`, and `tools: [{ type: 'web_search' }]` (`allowed_domains`
  is forwarded as `filters.allowed_domains`). `web_fetch` does a local HTTPS
  GET (HTTP is upgraded) through `$HTTPS_PROXY` / `http://127.0.0.1:7897`,
  matching grok-build's client-side fetch. `ctx.web` is only the fallback
  when the OAuth file is missing or the native call fails.
- **`get_task_output` / `kill_task`** use the DSH `jobs` service (`jobs.wait`, `jobs.read`,
  `jobs.kill`). `get_task_output` waits only when `timeout_ms > 0`, capped at 600000 ms.
- **`ask_user_question`** uses the DSH `userQuestions` service (`userQuestions.ask`), translating
  grok's `multi_select` into the service's `multiSelect`. When the service is unavailable it
  degrades gracefully: the caller is told to re-state the questions in its response text.
- **`todo_write`** keeps a **plugin-local `Map` keyed by agent id** (not the DSH todo service).
  `merge=true` (default) merges incoming items by `id` — status-only updates may omit `content` —
  and `merge=false` replaces the list. This matches grok's merge-by-id semantics without
  coupling to DSH's own todo service, which the grok preset disables anyway.
- **`task` matches the stock `subagent` tool.** Background is the default
  (`run_in_background !== false` → `subagents.startContinuable`), returning a durable child
  id at inbox acceptance. `resume` delivers `prompt` through `subagents.followup` (the same
  channel `send_message` uses). Foreground (`run_in_background: false`) awaits
  `subagents.start` and, on a non-`completed` stop, appends
  `"Partial output before the run ended:"` plus the child's text — the native wording.
  Every request sets `agentOptions` / `persona` / `maxDepth: 3` explicitly
  because the continuable route never calls `provider.start()`. `toolFilter` is
  deliberately NOT set: since dsh-tools 0.1.1-rc.2, `tools.restrict()` accepts only
  GLOBAL tool names and rejects scope-local (vendor) names — the mesh `agent/created`
  listener applies the child tool mask instead (mesh AGENTS.md §6). The tool declares
  `isConcurrencySafe: () => true` and registers a `systemPrompt` section (`tool:task`,
  order `116.5`) that teaches the background-first convention while the tool is visible.
  `subagent_type` maps onto the recipes in `lib/subagents.js` (`general-purpose` →
  `grok-agent`, `explore` → `grok-explore`, `plan` → `grok-plan`); provider preference is
  the recipe name when listed, then `grok-agent`, then `spawn`.
- **`enter_plan_mode` / `exit_plan_mode`** use the `planMode` service
  (`planMode.set(agent, true/false)`) and are only registered when `planMode` is present.

## The DSH ToolDefinition contract

DSH tool objects require `name`, `description`, a JSON-Schema-shaped `parameters` object,
`output: { schema, render }`, and an `execute(args, exec)` function (mesh AGENTS.md §3.4).
The `strDef(t)` helper attaches a shared `output` descriptor
(`{ schema: { type: 'string' }, render }`) that renders string results as plain text and
JSON-stringifies anything else — both `schema` and `render` are present on every
registration; do not fabricate extra result fields the schema does not declare.
`execute` receives `(args, exec)` where `args` are the validated tool arguments and `exec`
carries `exec.agent` and `exec.signal`; every implementation threads `exec.signal` into
the underlying async service call so cancellation propagates. The exact registration
surface is the DSH `tools` service's `register` method.

## Known gaps

- **`grep -B` / `-A` / `-C` are best-effort.** The schemas accept the context flags, but the
  native-walk implementation returns only matched lines with no before/after context. grok's
  own implementation (ripgrep-backed) does emit context lines.
- **`type` filtering is best-effort.** It compares the file extension lowercase against the
  argument rather than using real ripgrep type tables.
- **`allowed_domains` in `web_search` is forwarded to the grok CLI proxy.**
  The DeepSeek `ctx.web` fallback still cannot honor it.
- ~~**`run_in_background` for `task` runs foreground.**~~ **RESOLVED** (mesh gap #5). `task`
  is background-first on the native continuable route (`subagents.startContinuable`): omitting
  `run_in_background` (or setting it true) returns a durable child id that `list_agents` /
  `send_message` / `interrupt_agent` / `task.resume` operate on, exactly like the stock
  `subagent` tool. Set `run_in_background: false` only to wait for the one-shot result.
  See the `task` implementation note above.
- **`exit_plan_mode` presentation is left to DSH's own machinery.** The tool toggles the
  `planMode` flag and instructs the model to present the plan in its response text; it does not
  itself render the plan UI.
- **`header` and best-effort fields** on some tools (`ask_user_question` `header`, `grep`
  context flags) are accepted for schema fidelity but may not be fully honored.

### Mesh gaps this surface used to inherit (now resolved upstream)

These lived in `dsh-kernel-mesh` and are **not** open work for this package:

- ~~**Mesh gap #5 — continuable subagent route.**~~ **RESOLVED** in the mesh; this package's
  `task` consumes that route as its default (see above).
- ~~**Mesh gap #6 — non-streaming transports.**~~ **RESOLVED** in the mesh: both adapter
  factories stream real SSE (`stream: true`, curl `-N`) with JSON auto-fallback when a
  provider ignores streaming. This surface has no transport of its own.
- ~~**Unclassified adapter errors.**~~ **RESOLVED** in the mesh: adapters throw with
  canonical own-property codes (`e.code` + `e.failure`) so `dsh-llm-retry` retries
  `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`. This surface does not throw adapter
  errors.

## Testing notes

- **Syntax:** `node --check lib/index.js` is the fastest smoke test and should be run on every
  change; the file is plain ESM (`type: module`) with no build step.
- **Registration smoke test:** load the plugin under a DSH profile that has the colliding DSH
  rows *enabled* and confirm the `console.warn` backstop fires and the plugin still applies.
  Then load it under the grok-kernel preset (colliding rows disabled) and confirm all 15 tools
  register with no warnings.
- **Functional checks** (best run through an agent session using the grok-kernel preset):
  `list_dir` returns trailing-slash directory names; `search_replace` with empty `old_string`
  creates a file and with a normal `old_string` edits in place; `run_terminal_cmd` with
  `is_background=true` returns a task id that `get_task_output` can read and `kill_task` can
  stop; `task` defaults to a durable background child id, `resume` queues a follow-up, and
  `run_in_background: false` with `subagent_type: 'explore'` returns the subagent's text
  blocks (or `"Partial output before the run ended:"` on a non-completed stop).
- **Sandbox:** confirm `search_replace` writes succeed because `sandboxPolicy.resolve()` is
  threaded through to `fs.editText`.

## Layout

```
dsh-kernel-grok/
  lib/index.js      # the whole plugin (single-file ESM Cordis plugin)
  package.json      # type:module + exports/files/scripts.test (DSH plugin contract)
  LICENSE           # MIT, Copyright (c) 2026 oppnc
  README.md         # short human-facing English doc
  README.zh.md      # Chinese translation
  README.i18n.yaml  # bilingual-pair git blob hashes
  AGENTS.md         # this file
  AGENTS.zh-CN.md   # Chinese translation of this file
```
