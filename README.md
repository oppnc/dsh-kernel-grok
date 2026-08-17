English | [中文](README.zh.md)

# dsh-kernel-grok

DSH runs on one simple idea: **everything is a plugin**. Models, tools, subagents — plug them together however you like.

So we did exactly that: we turned **Grok Build into a DSH plugin**. The grok-build tool surface you already know — `run_terminal_cmd`, `read_file`, `search_replace`, `list_dir`, `grep`, `web_search`, `web_fetch`, `todo_write`, `task`, `get_task_output`, `kill_task`, `ask_user_question`, `enter_plan_mode`, `exit_plan_mode` — is now a set of native DSH tools. Same names, same schemas, same behavior.

The payoff is simple: use grok's tools natively inside DSH — **no different** from opening Grok Build itself. Every model stays in the environment it knows best — main agent or subagent, it feels like coming home.

> Two grok-native rules, kept as-is: `search_replace` IS grok's write tool (create a file by passing an empty `old_string`), and `run_terminal_cmd` requires a `description` saying why the command is needed.

`web_search` uses the Grok OAuth JWT against `cli-chat-proxy.grok.com` (`tools: [{type:'web_search'}]`), not DeepSeek's search provider. `web_fetch` is a local HTTPS GET through the same proxy grok-build uses. Distilled from grok-build `e5fd481` (2026-08-13); origin/main after that only changes workspace/permission/media internals — no new grok_build tool names.

## Install

Copy this directory into your profile, then add a row inside the **planning** group of the grok-kernel preset:

```yaml
- id: grok-surface
  name: dsh-kernel-grok
```

The grok-kernel preset already disables DSH's colliding rows for you (`tool-fs-search`, `tool-web`, `tool-todo`, `tool-ask-user`).

## Usage

Pick the **grok-kernel** preset and the **grok-kernel / grok-4.6** model. Your agent runs on the Grok kernel with grok's native tool surface.

## License

MIT — see [LICENSE](LICENSE).
