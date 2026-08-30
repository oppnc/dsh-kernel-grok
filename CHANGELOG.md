# Changelog

## 0.1.6

- **Mesh dependency + fallback mount.** `dsh-kernel-mesh` is now a declared
  dependency (`github:oppnc/dsh-kernel-mesh#semver:^0.1.6`), so installing this
  package also installs the mesh. At `apply()` time the plugin checks for the
  mesh's `kernelMesh` marker service / any `*-kernel` route; when the host
  composition never mounted the mesh, the plugin mounts its own copy
  (`lib/ensure-mesh.js`) so kernel routes and subagent recipes keep working —
  with a logged pointer to the preferred profile-level mount
  (`dsh plugin add dsh-kernel-mesh`), since a fallback-mounted mesh shares this
  row's lifecycle.

## 0.1.5

- **DSH 0.1.1-rc.2 compatibility: `task` no longer sets `toolFilter` on
  subagent requests.** The new dsh-tools restricts `tools.restrict()` to GLOBAL
  tool names and rejects scope-local (vendor) names; the child tool mask is
  applied by the mesh `agent/created` listener instead (mesh AGENTS.md §6).
  The smoke test now asserts the request carries no `toolFilter`.
- **Grok Build sync (e5fd481..origin/main, 2026-08).** `x-grok-client-version`
  bumped 1.0.3 → 1.0.12 (tracks `xai-grok-version/Cargo.toml`). Subagent
  recipes mirror upstream wiring: `grok-agent` no longer whitelists
  `ask_user_question` (upstream strips `ToolKind::AskUser` from every
  subagent). Upstream's new `send_subagent_message` tool ships feature-gated
  and off by default — not registered; `task.resume` covers the channel.
  Existing tool schemas unchanged (all upstream hunks were test-only).

## Unreleased

- **`GROK_HOME` honored** when locating `auth.json` (grok-build's own override).
- **Proxy defaults to direct.** `web_search`/`web_fetch` now honor
  `HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/`http_proxy` and fall back to a direct
  connection instead of a hardcoded local proxy port.

## 0.1.4

- **`task` reuses the L2 recipes.** The inline subagent definitions are gone;
  `task` maps `general-purpose`/`explore`/`plan` onto `lib/subagents.js`
  (upstream grok-build `subagent_prompt.md` + `task.rs` prompts).
- **`explore`/`plan` match upstream read-only tool sets.** `explore` =
  `read_file`/`list_dir`/`grep`; `plan` adds `web_search`/`todo_write`.

## 0.1.3

- **Upstream system prompt.** `lib/system-prompt.js` carries the Grok Build
  `prompt.md` (resolved for the DSH tool surface); `apply()` registers it as the
  `deployment:persona` section with `complete: true` + `suppressRuntimeContext()`,
  so a session on this kernel sees ONLY the Grok Build prompt.
- **L2 subagent recipes.** `lib/subagents.js` ships `grok-agent` (general-purpose),
  `grok-explore`, and `grok-plan`, each = the upstream `subagent_prompt.md` with
  the built-in role prompt (`GENERAL_PURPOSE_PROMPT` / `EXPLORE_PROMPT` /
  `PLAN_PROMPT` from `xai-tool-types`) injected as `<role-instructions>`.
- **Subagent mounting config.** `apply(ctx, config)` accepts `config.persona`
  (override the default prompt), `config.skipPersona` (tools only), and
  `config.tools` (register only the whitelisted tools).

## 0.1.2

- Initial DSH-form grok-build tool surface.
