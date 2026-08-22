# Changelog

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
