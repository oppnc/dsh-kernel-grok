[English](README.md) | 中文

# dsh-kernel-grok

DSH 有个很朴素的想法：**一切都是插件**。模型是插件，工具是插件，子代理也是插件，想怎么拼就怎么拼。

顺着这个思路，我们把 **Grok Build 写成了 DSH 插件**。你熟悉的 grok-build 工具面——`run_terminal_cmd`、`read_file`、`search_replace`、`list_dir`、`grep`、`web_search`、`web_fetch`、`todo_write`、`task`、`get_task_output`、`kill_task`、`ask_user_question`、`enter_plan_mode`、`exit_plan_mode`——现在就是 DSH 的原生工具，名字一样、schema 一样、行为一样。

好处很简单：在 DSH 里原生使用 grok 这套工具，和直接打开 Grok Build **没有任何区别**。每个模型都待在自己最熟悉的环境里，不管是主 agent 还是 subagent，感觉就像回家一样。

> 两条 grok 原生的规矩，原样保留：`search_replace` 就是 grok 的写入工具（新建文件传空 `old_string`）；`run_terminal_cmd` 必须带 `description` 说明为什么要跑这条命令。

`web_search` 用 Grok OAuth JWT 打 `cli-chat-proxy.grok.com`（`tools: [{type:'web_search'}]`），不走 DeepSeek 搜索。`web_fetch` 是经同一代理的本地 HTTPS GET。对齐 grok-build `e5fd481`（2026-08-13）；之后 origin/main 只动 workspace/权限/媒体内部，没有新的 grok_build 工具名。

## 安装

把本目录复制到你的 profile，然后在 grok-kernel 预设的 **planning** 分组里加一行：

```yaml
- id: grok-surface
  name: dsh-kernel-grok
```

grok-kernel 预设已经替你禁用了 DSH 里重名的行（`tool-fs-search`、`tool-web`、`tool-todo`、`tool-ask-user`）。

## 使用

选 **grok-kernel** 预设和 **grok-kernel / grok-4.6** 模型。你的 agent 就跑在 Grok 内核上，用的还是 grok 原生那套工具。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
