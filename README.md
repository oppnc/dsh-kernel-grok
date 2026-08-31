English | [中文](README.zh.md)

# dsh-kernel-grok

DSH runs on one simple idea: **everything is a plugin**. Models, tools, subagents — plug them together however you like.

So we did exactly that: we turned **Grok Build into a DSH plugin**. The grok-build tool surface you already know — `run_terminal_cmd`, `read_file`, `search_replace`, `list_dir`, `grep`, `web_search`, `web_fetch`, `todo_write`, `task`, `get_task_output`, `kill_task`, `ask_user_question`, `enter_plan_mode`, `exit_plan_mode` — is now a set of native DSH tools. Same names, same schemas, same behavior.

The payoff is simple: use grok's tools natively inside DSH — **no different** from opening Grok Build itself. Every model stays in the environment it knows best — main agent or subagent, it feels like coming home.

> Two grok-native rules, kept as-is: `search_replace` IS grok's write tool (create a file by passing an empty `old_string`), and `run_terminal_cmd` requires a `description` saying why the command is needed.

`web_search` uses the Grok OAuth JWT against `cli-chat-proxy.grok.com` (`tools: [{type:'web_search'}]`), not DeepSeek's search provider. `web_fetch` is a local HTTPS GET through the same proxy grok-build uses. Distilled from grok-build `e5fd481` (2026-08-13); origin/main after that only changes workspace/permission/media internals — no new grok_build tool names.

## System prompt & subagents

`lib/system-prompt.js` carries the upstream **Grok Build** `prompt.md` (resolved
for the DSH tool surface); `apply()` registers it as the agent's sole
system-prompt section (`complete: true` + `suppressRuntimeContext()`).

`lib/subagents.js` ships the kernel's own subagent recipes — `grok-agent`
(general-purpose), `grok-explore`, `grok-plan` — each = the upstream
`subagent_prompt.md` with the built-in role prompt injected. The mesh loads them
and mounts this plugin on each child with a `config.tools` whitelist, so a grok
subagent sees and uses exactly grok's subagent tools.

## Install

1. Install the plugin into your profile with the official plugin command:

   ```sh
   dsh plugin --profile web add github:oppnc/dsh-kernel-grok
   ```

   Once the package is on npm, `dsh plugin --profile web add dsh-kernel-grok` is preferred (prebuilt, no `allowBuilds`).

   This package is a plain plugin (no `dsh.bundle` declaration), so `dsh plugin` installs it as an inactive dependency — that is expected: the preset row below references it by name.

2. The `grok-kernel` agent preset ships in `dsh-kernel-mesh`'s `presets/` directory. Copy it into the official user-preset root (or, if you run without the mesh, get the preset directory from the mesh repo):

     ```sh
     dsh_home="${DSH_HOME:-$HOME/.dsh}"
     cp -r "$dsh_home/profiles/web/node_modules/dsh-kernel-mesh/presets/grok-kernel" "$dsh_home/.agent-presets/"
     ```

     The preset already includes the `grok-surface` row inside the **planning** group; if you author your own preset, add it there:

   ```yaml
   - id: grok-surface
     name: dsh-kernel-grok
   ```

   The grok-kernel preset also disables DSH's colliding rows for you (`tool-fs-search`, `tool-web`, `tool-todo`, `tool-ask-user`).

## Usage

Pick the **grok-kernel** preset and the **grok-kernel / grok-4.6** model. Your agent runs on the Grok kernel with grok's native tool surface.

## License

MIT — see [LICENSE](LICENSE).
