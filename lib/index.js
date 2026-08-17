// dsh-kernel-grok — "Grok Build CLish written in DSH form": the Grok Build tool surface
// registered as DSH tools with the SAME names, schemas and semantics, implemented
// directly on DSH services (fs/web/subprocess/jobs/subagents/planMode),
// so the surface survives toolFilter scoping. Schemas distilled from
// xai-org/grok-build crates (crates/codegen/xai-grok-tools/src/implementations/grok_build/*).
// web_search uses the same Grok OAuth + cli-chat-proxy Responses wire as grok-build
// (tools: [{type:'web_search'}]); web_fetch prefers a local HTTPS GET like upstream.
import fsNative from 'node:fs'
import os from 'node:os'
import pathNative from 'node:path'
import { spawn } from 'node:child_process'

const GROK_HOME = process.env.USERPROFILE || process.env.HOME || os.homedir()
const GROK_PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || 'http://127.0.0.1:7897'
const GROK_SEARCH_URL = 'https://cli-chat-proxy.grok.com/v1/responses'

function curlBin() {
  return process.platform === 'win32'
    ? pathNative.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe')
    : 'curl'
}

function readTextFile(p) {
  try { return fsNative.readFileSync(p, 'utf8') } catch { return '' }
}

function loadGrokKey() {
  try {
    const auth = JSON.parse(readTextFile(pathNative.join(GROK_HOME, '.grok', 'auth.json')))
    const k = Object.keys(auth)[0]
    if (k && auth[k] && typeof auth[k].key === 'string') return auth[k].key
  } catch {}
  return ''
}

function grokSearchHeaders(key) {
  return {
    'content-type': 'application/json',
    authorization: 'Bearer ' + key,
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-authenticateresponse': 'authenticate-response',
    'x-grok-client-mode': 'headless',
    'x-grok-client-version': '1.0.3',
    'user-agent': 'dsh-kernel-grok/0.1.2',
  }
}

function curlRequest(opts) {
  const argv = [curlBin(), '-sS', '-m', String(opts.timeoutSec || 90)]
  if (opts.proxy) argv.push('-x', opts.proxy)
  if (opts.method && opts.method !== 'GET') argv.push('-X', opts.method)
  for (const key of Object.keys(opts.headers || {})) argv.push('-H', key + ': ' + opts.headers[key])
  if (opts.body != null) argv.push('--data-binary', '@-')
  argv.push(opts.url)
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    const err = []
    let aborted = false
    const onAbort = () => { aborted = true; try { child.kill() } catch {} }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))
    child.stdin.on('error', () => {})
    child.on('error', (e) => reject(new Error('curl spawn failed: ' + String(e))))
    child.on('close', (code) => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
      const body = Buffer.concat(out).toString('utf8')
      if (aborted) { reject(new Error('aborted')); return }
      if (code !== 0) { reject(new Error('curl exit ' + code + ': ' + Buffer.concat(err).toString('utf8').slice(0, 300))); return }
      resolve(body)
    })
    if (opts.body != null) child.stdin.write(opts.body)
    child.stdin.end()
  })
}

function extractGrokSearch(data) {
  const texts = []
  const links = []
  const seen = new Set()
  const pushLink = (title, url) => {
    if (!url || seen.has(url)) return
    seen.add(url)
    links.push({ title: title || url, url })
  }
  const walk = (node) => {
    if (!node) return
    if (Array.isArray(node)) { for (const x of node) walk(x); return }
    if (typeof node !== 'object') return
    if ((node.type === 'output_text' || node.type === 'text') && typeof node.text === 'string') texts.push(node.text)
    if (Array.isArray(node.annotations)) {
      for (const a of node.annotations) {
        if (!a) continue
        const url = a.url || (a.type === 'url_citation' && a.url)
        if (url) pushLink(a.title, url)
      }
    }
    if (node.action && Array.isArray(node.action.sources)) {
      for (const s of node.action.sources) {
        const url = s && (s.url || (s.type === 'url' && s.url))
        if (url) pushLink(s.title, url)
      }
    }
    if (Array.isArray(node.output)) walk(node.output)
    if (Array.isArray(node.content)) walk(node.content)
  }
  walk(data)
  let out = texts.join('\n').trim()
  if (links.length) {
    out += (out ? '\n\n' : '') + 'Links:\n' + links.map((l, i) => (i + 1) + '. [' + l.title + '](' + l.url + ')').join('\n')
  }
  return out || '(no results)'
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

async function grokSearchNative(args, signal) {
  const key = loadGrokKey()
  if (!key) return null
  const body = {
    model: 'grok-4.6',
    input: String(args.query),
    tools: [{
      type: 'web_search',
      filters: Array.isArray(args.allowed_domains) && args.allowed_domains.length
        ? { allowed_domains: args.allowed_domains }
        : undefined,
    }],
    store: false,
    temperature: 0.1,
    top_p: 0.95,
    max_output_tokens: 2048,
  }
  if (!body.tools[0].filters) delete body.tools[0].filters
  const raw = await curlRequest({
    url: GROK_SEARCH_URL,
    method: 'POST',
    timeoutSec: 90,
    proxy: GROK_PROXY,
    signal,
    headers: grokSearchHeaders(key),
    body: JSON.stringify(body),
  })
  let parsed
  try { parsed = JSON.parse(raw) } catch { throw new Error('grok search: bad JSON ' + String(raw).slice(0, 200)) }
  if (parsed && parsed.error) throw new Error('grok search: ' + JSON.stringify(parsed.error).slice(0, 300))
  return extractGrokSearch(parsed)
}

async function grokFetchNative(url, signal) {
  let target = String(url || '')
  if (/^http:\/\//i.test(target)) target = 'https://' + target.slice(7)
  const raw = await curlRequest({
    url: target,
    method: 'GET',
    timeoutSec: 60,
    proxy: GROK_PROXY,
    signal,
    headers: {
      'user-agent': 'dsh-kernel-grok/0.1.2',
      accept: 'text/markdown, text/plain, text/html;q=0.8, */*;q=0.5',
    },
  })
  const trimmed = String(raw || '').trim()
  if (!trimmed) return '(empty body)'
  const text = /^\s*</.test(trimmed) ? htmlToText(trimmed) : trimmed
  if (text.length > 20000) return text.slice(0, 20000) + '\n[truncated at 20000 chars]'
  return text || '(empty body)'
}

function globFragment(p) {
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') { re += p[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += 1; if (p[i + 1] === '/') i += 1 } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = p.indexOf('}', i)
      if (end > i) {
        const opts = p.slice(i + 1, end).split(',').map((o) => globFragment(o))
        re += '(' + opts.join('|') + ')'
        i = end
      } else re += '\\{'
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return re
}

function globToRegex(pattern) {
  const p = String(pattern).replace(/\\/g, '/')
  try { return new RegExp('^' + globFragment(p) + '$') } catch { return null }
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result) {
  switch (result.stopReason) {
    case 'completed': return undefined
    case 'aborted': return 'subagent run was cancelled'
    case 'error': return 'subagent run failed'
    case 'max-tokens': return 'subagent run hit its token limit before finishing'
    case 'refusal': return 'subagent declined the task'
    default: return 'subagent run ended abnormally (' + String(result.stopReason) + ')'
  }
}

/**
 * Append the child's preserved partial answer to a stop-reason error so a
 * truncated or cancelled child's real text still reaches the parent model.
 * Wording matches the stock `subagent` tool.
 */
function withPartialText(error, output) {
  const blocks = Array.isArray(output) ? output : []
  const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
  return text.length === 0 ? error : error + '\nPartial output before the run ended:\n' + text
}

function textOf(output) {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return ''
  return output.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
}

const name = 'dsh-kernel-grok'
const inject = ['fs', 'tools', 'subprocess', 'web', 'jobs']

async function apply(ctx) {
    const fs = ctx.get('fs')
    const tools = ctx.get('tools')
    const web = ctx.get('web')
    const planMode = ctx.get('planMode')
    const subagents = ctx.get('subagents')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const subprocess = ctx.get('subprocess')
    const jobs = ctx.get('jobs')
    if (!tools || !fs) return

    // Register only names that do not collide with DSH's own tools (grok's
    // snake_case names overlap with DSH's grep/web_search/todo_write/
    // ask_user_question/exit_plan_mode). The grok-kernel preset disables the
    // colliding DSH rows; this try/catch is the ordering-independent backstop.
    const register = (t) => {
      try { tools['register'](t) } catch (e) {
        console.warn('[dsh-kernel-grok] skipping tool "' + t.name + '": ' + String(e))
      }
    }

    const SKIP_DIRS = new Set(['node_modules', '.git', '.grok', '.venv', '__pycache__', 'dist', 'target'])
    const policyFor = (exec) => {
      try {
        if (sandboxPolicy && typeof sandboxPolicy.resolve === 'function') {
          return sandboxPolicy.resolve(exec && exec.agent && exec.agent.session ? { session: exec.agent.session } : {})
        }
      } catch {}
      return undefined
    }
    const cwdOf = (exec) => {
      const policy = policyFor(exec)
      if (policy && typeof policy.workspaceRoot === 'string') return policy.workspaceRoot
      try { if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string') return sandboxPolicy.workspaceRoot } catch {}
      try { return process.cwd() } catch {}
      return 'C:\\'
    }
    const strDef = (t) => {
      t.output = { schema: { type: 'string' }, render: (a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] }
      return t
    }

    // shared recursive walker over fs.listDir (listDir already returns resolved child targets)
    async function walk(dirTarget, rel, out, max, signal, depth) {
      if (out.length >= max || (depth || 0) > 64) return
      let entries
      try { entries = await fs.listDir(dirTarget, signal) } catch { return }
      for (const e of entries || []) {
        if (out.length >= max) return
        const name = e.name
        if (SKIP_DIRS.has(name)) continue
        const isDir = e.type === 'directory'
        const childRel = rel ? rel + '/' + name : name
        if (isDir) {
          try { await walk(e.target, childRel, out, max, signal, (depth || 0) + 1) } catch {}
        } else {
          out.push({ rel: childRel, target: e.target })
        }
      }
    }

    // ---- run_terminal_cmd (bash/mod.rs BashToolInput) ----
    register(strDef({
      name: 'run_terminal_cmd',
      description: 'Executes a shell command (PowerShell on this machine). timeout in milliseconds (max 300000, default 120000). is_background=true returns a task id immediately and keeps running in the background; use get_task_output and kill_task to manage it. description is required and must state why the command is needed.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to run.' },
          timeout: { type: 'integer', description: 'Optional timeout in milliseconds (max 300000). Default: 120000 (2 minutes).', default: 120000 },
          description: { type: 'string', description: 'One sentence explanation as to why this command needs to be run and how it contributes to the goal.' },
          is_background: { type: 'boolean', description: 'Set to true for long-running commands that should run in the background (e.g., dev servers, long builds). Returns a task id immediately.', default: false },
        },
        required: ['command', 'description'],
      },
      execute: async (args, exec) => {
        if (!subprocess) return 'Error: subprocess service unavailable.'
        let pwshBin = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
        try { const r = await subprocess.resolveExecutable('pwsh.exe', undefined, exec.signal); if (r) pwshBin = r } catch {}
        const argv = [pwshBin, '-NoProfile', '-NonInteractive', '-Command', args.command]
        const stdioSpec = { stdin: 'ignore', stdout: { maxBytes: 1000000 }, stderr: { maxBytes: 100000 } }
        if (args.is_background === true) {
          if (!jobs) return 'Error: jobs service unavailable.'
          if (exec.signal && exec.signal.aborted) return 'run_terminal_cmd: aborted before start.'
          // Spawn INSIDE run(): jobs.start preflights first (controller, label,
          // per-owner cap) and only then invokes run(), so a preflight failure
          // can never leak a live process tree.
          let handle = null
          let cursor = 0
          let errCursor = 0
          const id = jobs.start({
            kind: 'shell',
            label: String(args.description || args.command).slice(0, 120) || 'run_terminal_cmd',
            owner: exec.agent,
            run: () => {
              handle = subprocess.spawn({ argv, cwd: cwdOf(exec), stdio: stdioSpec, graceMs: 3000 })
              return {
                cancel: (reason) => { try { handle.terminate() } catch {} },
                done: handle.done.then(
                  (o) => ({ status: o.exitCode === 0 ? 'completed' : 'failed', detail: 'exit ' + o.exitCode }),
                  (e) => ({ status: 'failed', detail: String(e) }),
                ),
                readOutput: () => {
                  const rd = handle.collected.stdout ? handle.collected.stdout.readFrom(cursor) : { text: '', nextOffset: cursor }
                  cursor = rd.nextOffset
                  const er = handle.collected.stderr ? handle.collected.stderr.readFrom(errCursor) : { text: '', nextOffset: errCursor }
                  errCursor = er.nextOffset
                  return rd.text + (er.text ? '\n[stderr]\n' + er.text : '')
                },
              }
            },
          })
          return 'Background task started: ' + id
        }
        const handle = subprocess.spawn({ argv, cwd: cwdOf(exec), stdio: stdioSpec, graceMs: 3000, signal: exec.signal })
        const doneSafe = handle.done.then(
          (o) => ({ ok: true, o }),
          (e) => ({ ok: false, e }),
        )
        const timeoutMs = Math.max(1000, Math.min(300000, args.timeout || 120000))
        let timer = null
        let outcome
        try {
          outcome = await Promise.race([
            doneSafe,
            new Promise((resolve) => {
              timer = setTimeout(() => {
                try { handle.terminate() } catch {}
                resolve(null)
              }, timeoutMs)
            }),
          ])
        } finally {
          if (timer) clearTimeout(timer)
        }
        if (outcome === null) {
          // Terminate escalates asynchronously; wait (or until the turn aborts)
          // so collected output is complete.
          const grace = new Promise((resolve) => {
            const t = setTimeout(resolve, 4000)
            if (exec.signal) exec.signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
          })
          await Promise.race([handle.done.catch(() => {}), grace])
        }
        const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
        const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
        if (outcome === null) {
          return (out + (err ? '\n[stderr]\n' + err : '')).trim() + '\n[timed out after ' + Math.round(timeoutMs / 1000) + 's]'
        }
        if (!outcome.ok) {
          return (out + (err ? '\n[stderr]\n' + err : '')).trim() + '\n[spawn failed: ' + String(outcome.e) + ']'
        }
        return (out + (err ? '\n[stderr]\n' + err : '')).trim() + '\n[exit code: ' + outcome.o.exitCode + ']'
      },
    }))

    // ---- read_file (read_file/mod.rs ReadFileInput) ----
    register(strDef({
      name: 'read_file',
      description: 'Reads a file. The path can be a relative path in the workspace or an absolute path. By default reads up to 1000 lines; use offset and limit for large files.',
      parameters: {
        type: 'object',
        properties: {
          target_file: { type: 'string', description: 'The path of the file to read. You can use either a relative path in the workspace or an absolute path. If an absolute path is provided, it will be preserved as is.' },
          offset: { type: 'integer', description: 'The line number to start reading from. Only provide if the file is too large to read at once.', default: 1 },
          limit: { type: 'integer', description: 'The number of lines to read. Only provide if the file is too large to read at once.', default: 1000 },
        },
        required: ['target_file'],
      },
      execute: async (args, exec) => {
        const target = await fs.resolve(args.target_file, { cwd: cwdOf(exec), signal: exec.signal })
        const raw = await fs.readText(target, exec.signal)
        const lines = raw.split(/\r?\n/)
        const off = args.offset || 1
        const n = Math.max(1, args.limit || 1000)
        const start = off > 0 ? Math.min(off - 1, lines.length) : Math.max(0, lines.length + off)
        return lines.slice(start, start + n).join('\n')
      },
    }))

    // ---- search_replace (search_replace/mod.rs SearchReplaceInput) ----
    // grok-build has no separate "write_file"; file creation is old_string="" semantics.
    register(strDef({
      name: 'search_replace',
      description: 'Replaces an exact string in a file. old_string must match exactly one place in the file; if it appears more than once, add surrounding lines to make it unique, or set replace_all to change every occurrence. To create a new file, set old_string to an empty string.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The path to the file to modify. You can use either a relative path in the workspace or an absolute path.' },
          old_string: { type: 'string', description: 'The text to replace.' },
          new_string: { type: 'string', description: 'The text to replace it with (must be different from old_string).' },
          replace_all: { type: 'boolean', description: 'Replace all occurrences of old_string (default false).', default: false },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
      execute: async (args, exec) => {
        const policy = policyFor(exec)
        const target = await fs.resolve(args.file_path, { cwd: cwdOf(exec), signal: exec.signal })
        if (args.old_string === '') {
          // grok-build has no separate write_file: creating/overwriting a file is
          // old_string="". DSH editText rejects an empty oldString, so this path
          // is an unconditional write instead.
          await fs.writeText(target, args.new_string, undefined, exec.signal, policy)
          return 'File successfully written: ' + args.file_path
        }
        await fs.editText(target, { oldString: args.old_string, newString: args.new_string, replaceAll: args.replace_all === true }, undefined, exec.signal, policy)
        return 'File successfully edited: ' + args.file_path
      },
    }))

    // ---- list_dir (list_dir/mod.rs ListDirInput) ----
    register(strDef({
      name: 'list_dir',
      description: 'Lists the contents of a directory recursively (respecting a max depth and entry cap in DSH form). path is relative to the workspace root or absolute.',
      parameters: {
        type: 'object',
        properties: {
          target_directory: { type: 'string', description: 'Path to directory to list contents of, relative to the workspace root or absolute.' },
        },
        required: ['target_directory'],
      },
      execute: async (args, exec) => {
        const base = args.target_directory || '.'
        const root = await fs.resolve(base, { cwd: cwdOf(exec), signal: exec.signal })
        const out = []
        const MAX = 2000
        async function rec(dirTarget, rel, depth) {
          if (out.length >= MAX || depth > 8) return
          const entries = await fs.listDir(dirTarget, exec.signal)
          for (const e of entries || []) {
            if (out.length >= MAX) return
            if (SKIP_DIRS.has(e.name)) continue
            const isDir = e.type === 'directory'
            const childRel = rel ? rel + '/' + e.name : e.name
            out.push(childRel + (isDir ? '/' : ''))
            if (isDir && depth < 8) {
              try { await rec(e.target, childRel, depth + 1) } catch {}
            }
          }
        }
        try {
          await rec(root, '', 1)
        } catch (e) {
          return 'list_dir error: ' + String(e)
        }
        return out.sort().join('\n') || '(empty directory)'
      },
    }))

    // ---- grep (grep/mod.rs GrepSearchInput) ----
    register(strDef({
      name: 'grep',
      description: 'Searches file contents with a regular expression (ripgrep in grok; native regex walk in DSH form). Full regex syntax, so escape literal special characters. Use glob/type to filter files. head_limit caps results.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The regular expression pattern to search for in file contents.' },
          path: { type: 'string', description: 'File or directory to search in. Defaults to the workspace path.' },
          glob: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}").' },
          '-B': { type: 'integer', description: 'Number of lines to show before each match (best-effort in DSH form).' },
          '-A': { type: 'integer', description: 'Number of lines to show after each match (best-effort in DSH form).' },
          '-C': { type: 'integer', description: 'Number of lines to show before and after each match (best-effort in DSH form).' },
          '-i': { type: 'boolean', description: 'Case insensitive search.', default: false },
          type: { type: 'string', description: 'File type to search. Common types: js, py, rust, go, java, etc. (best-effort extension filter in DSH form).' },
          head_limit: { type: 'integer', description: 'Limit output to first N lines/entries.', default: 200 },
          multiline: { type: 'boolean', description: 'Enable multiline mode where . matches newlines.', default: false },
        },
        required: ['pattern'],
      },
      execute: async (args, exec) => {
        let re
        try { re = new RegExp(args.pattern, (args['-i'] === true ? 'i' : '') + (args.multiline === true ? 's' : '')) } catch (e) { return 'Invalid regex: ' + String(e) }
        let filter = null
        if (args.glob) {
          filter = globToRegex(args.glob)
          if (!filter) return 'Invalid glob: ' + args.glob
        }
        const base = args.path && args.path !== '.' ? args.path : cwdOf(exec)
        const root = await fs.resolve(base, { cwd: cwdOf(exec), signal: exec.signal })
        let files
        let singleFile = false
        let rootInfo
        try { rootInfo = await fs.stat(root, exec.signal) } catch { rootInfo = null }
        if (rootInfo && rootInfo.type === 'file') {
          files = [{ rel: typeof args.path === 'string' ? String(args.path) : '.', target: root }]
          singleFile = true
        } else {
          files = []
          await walk(root, '', files, 3000, exec.signal)
        }
        const lines = []
        for (const item of files) {
          const rel = item.rel
          // ripgrep matches simple globs like "*.js" against the basename, so a
          // filter must match either the full relative path or the basename.
          const baseName = rel.split('/').pop()
          if (filter && !filter.test(rel) && !filter.test(baseName)) continue
          if (args.type && !singleFile) {
            const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()
            if (ext !== String(args.type).toLowerCase()) continue
          }
          let text
          try {
            const info = await fs.stat(item.target, exec.signal)
            if (info && info.size > 512 * 1024) continue
            text = await fs.readText(item.target, exec.signal)
          } catch { continue }
          if (args.multiline === true) {
            // Whole-text matching so patterns can span newlines (. matches \n
            // via the s flag); report EVERY match, not just the first.
            const re2 = new RegExp(args.pattern, (args['-i'] === true ? 'i' : '') + 'gs')
            let m
            while ((m = re2.exec(text)) !== null) {
              const upto = text.slice(0, m.index).split(/\r?\n/).length
              lines.push(rel + ':' + upto + ':' + m[0].slice(0, 200).replace(/\r?\n/g, '\\n'))
              if (m.index === re2.lastIndex) re2.lastIndex++
            }
            continue
          }
          const fileLines = text.split(/\r?\n/)
          for (let i = 0; i < fileLines.length; i++) {
            if (re.test(fileLines[i])) {
              lines.push(rel + ':' + (i + 1) + ':' + fileLines[i])
            }
          }
        }
        const limit = args.head_limit != null ? args.head_limit : 200
        return lines.slice(0, limit).join('\n') || '(no matches)'
      },
    }))

    // ---- web_search (web_search/mod.rs WebSearchInput) ----
    register(strDef({
      name: 'web_search',
      description: 'Searches the web for up-to-date information, tailored for coding and software development tasks.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query to perform.' },
          allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Optional list of domains to restrict search to (best-effort in DSH form).' },
        },
        required: ['query'],
      },
      execute: async (args, exec) => {
        try {
          const native = await grokSearchNative(args, exec && exec.signal)
          if (native != null) return native
        } catch (e) {
          if (!web) return 'web_search failed: ' + String(e)
        }
        if (!web) return '(web service unavailable; grok OAuth also missing)'
        const res = await web.search({ query: args.query, maxResults: 10 }, exec.signal)
        let out = ''
        for (const s of res.sources || []) {
          out += '- [' + (s.title || s.url) + '](' + s.url + ')' + (s.snippet ? '\n  ' + s.snippet : '') + '\n'
        }
        return out || '(no results)'
      },
    }))

    // ---- web_fetch (web_fetch/mod.rs WebFetchInput) ----
    register(strDef({
      name: 'web_fetch',
      description: 'Fetches the content of a specific URL and returns it. Fails for authenticated or private URLs.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch content from.' },
        },
        required: ['url'],
      },
      execute: async (args, exec) => {
        try {
          return await grokFetchNative(args.url, exec && exec.signal)
        } catch (e) {
          if (web) {
            try {
              const f = await web.fetch({ url: args.url }, exec.signal)
              const content = f.body && typeof f.body.content === 'string' ? f.body.content : ''
              if (content) {
                if (content.length > 20000) return content.slice(0, 20000) + '\n[truncated at 20000 chars]'
                return content
              }
            } catch {}
          }
          return 'web_fetch failed: ' + String(e)
        }
      },
    }))

    // ---- todo_write (todo/mod.rs TodoWriteInput) ----
    const todoStore = new Map()
    register(strDef({
      name: 'todo_write',
      description: 'Creates and manages a structured task list. The user sees this list live. merge=true (default) merges by id; send only changed items. merge=false replaces the list.',
      parameters: {
        type: 'object',
        properties: {
          merge: { type: 'boolean', description: 'When true (default), merges the provided todos into the existing list by id — send only the items you are changing (to flip status send just id + status). When false, the provided todos replace the existing list.', default: true },
          todos: {
            type: 'array',
            description: 'Array of todo items to write to the workspace.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique identifier for the todo item.' },
                content: { type: 'string', description: 'The description/content of the todo item.' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'], description: 'The status of the todo item: pending, in_progress, completed, or cancelled.' },
              },
              required: ['id', 'status'],
              additionalProperties: false,
            },
          },
        },
        required: ['todos'],
      },
      execute: async (args, exec) => {
        const key = exec.agent && exec.agent.id != null ? String(exec.agent.id) : 'default'
        const merge = args.merge !== false
        const incoming = Array.isArray(args.todos) ? args.todos : []
        let list = []
        if (merge && todoStore.has(key)) {
          list = todoStore.get(key)
          const byId = new Map(list.map((t) => [t.id, t]))
          for (const u of incoming) byId.set(u.id, { id: u.id, content: u.content || byId.get(u.id)?.content || u.id, status: u.status })
          list = Array.from(byId.values())
        } else {
          list = incoming.map((u) => ({ id: u.id, content: u.content || u.id, status: u.status || 'pending' }))
        }
        todoStore.set(key, list)
        if (list.length === 0) return '(no tasks currently tracked)'
        return list.map((t) => '- [[' + t.status + ']] ' + t.id + ': ' + t.content).join('\n')
      },
    }))

    // ---- get_task_output (task_output GetTaskOutput via TaskOutputToolInput) ----
    register(strDef({
      name: 'get_task_output',
      description: 'Gets the output of background tasks by task id. timeout_ms positive waits up to that many milliseconds; omit or 0 polls without blocking.',
      parameters: {
        type: 'object',
        properties: {
          task_ids: { type: 'array', items: { type: 'string' }, description: 'Task IDs to get output from. Pass one or more; for a single task use a one-element array.' },
          timeout_ms: { type: 'integer', description: 'Max wait time in milliseconds. A positive value waits for completion; omit or pass 0 for a non-blocking status poll.', default: 0 },
        },
        required: ['task_ids'],
      },
      execute: async (args, exec) => {
        if (!jobs) return '(jobs service unavailable)'
        const ids = Array.isArray(args.task_ids) ? args.task_ids : [args.task_ids]
        const out = []
        // One shared wait-all budget: a positive timeout_ms is the TOTAL wait
        // across every id, not a per-id budget.
        const budget = args.timeout_ms && args.timeout_ms > 0 ? Math.min(args.timeout_ms, 600000) : 0
        const deadline = budget > 0 ? Date.now() + budget : 0
        for (const id of ids) {
          try {
            if (deadline > 0) {
              const left = deadline - Date.now()
              if (left > 0) await jobs.wait(id, Math.max(1, left), exec.agent, exec.signal)
            }
            const read = await jobs.read(id, exec.agent)
            out.push('[' + id + ']\n' + (read.text || '[' + read.snapshot.status + '] ' + (read.snapshot.detail || '')))
          } catch (e) {
            out.push('[' + id + '] error: ' + String(e))
          }
        }
        return out.join('\n\n') || '(no output)'
      },
    }))

    // ---- kill_task (kill_task/mod.rs KillTaskToolInput) ----
    register(strDef({
      name: 'kill_task',
      description: 'Terminates a background task (subagent or shell command) by task id.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to terminate.' },
        },
        required: ['task_id'],
      },
      execute: async (args, exec) => {
        if (!jobs) return '(jobs service unavailable)'
        const outcome = jobs.kill(args.task_id, exec.agent, 'Stopped by kill_task')
        return 'kill_task: ' + outcome
      },
    }))

    // ---- ask_user_question (ask_user_question AskUserQuestionInput) ----
    register(strDef({
      name: 'ask_user_question',
      description: 'Presents the user with structured questions and option sets. Use to clarify requirements, disambiguate approaches, and gather preferences. Each question needs a label-paired option list; multi_select lets the user pick more than one.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: 'The questions to ask, each with its own options.',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: 'The question to ask, phrased as a full question.' },
                header: { type: 'string', description: 'Short category tag for the question (best-effort in DSH form).', default: '' },
                options: {
                  type: 'array',
                  description: 'The choices for this question.',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: 'Option text shown to the user. A few words at most.' },
                      description: { type: 'string', description: 'What picking this option means or implies.' },
                    },
                    required: ['label', 'description'],
                    additionalProperties: false,
                  },
                },
                multi_select: { type: 'boolean', description: 'Let the user pick more than one option (default false).', default: false },
              },
              required: ['question', 'options'],
              additionalProperties: false,
            },
          },
        },
        required: ['questions'],
      },
      execute: async (args, exec) => {
        const userQuestions = ctx.get('userQuestions')
        if (!userQuestions) return 'ask_user_question is not available; re-state the question to the user in your response text and await their answer. Questions: ' + (args.questions || []).map((q) => q.question).join(' | ')
        try {
          const answer = await userQuestions.ask({
            questions: (args.questions || []).map((q, i) => ({
              id: String(q.id || 'q' + (i + 1)),
              question: q.question,
              header: q.header || undefined,
              options: (q.options || []).map((o) => ({ label: o.label, description: o.description || undefined })),
              multiSelect: q.multi_select === true,
            })),
            agent: exec.agent,
            signal: exec.signal,
          })
          return JSON.stringify(answer)
        } catch (e) {
          return 'ask_user_question error: ' + String(e)
        }
      },
    }))

    // ---- task (task/mod.rs TaskToolInput → TaskTool) ----
    // grok's built-in subagent types, self-contained: persona (distilled from
    // grok-build's own subagent prompts) and toolFilter (grok-surface tool
    // names) are set EXPLICITLY on every request because DSH's continuable
    // (background) route never invokes provider.start() — the continuation
    // manager rebuilds the child from the request fields recorded in the
    // durable descriptor. Do not rely on a recipe provider to inject them.
    const GROK_SUBAGENTS = {
      'general-purpose': {
        provider: 'grok-agent',
        persona: 'You are the Grok Build "general-purpose" subagent. Complete the assigned task directly: do what was asked, nothing more, nothing less. Respond with a detailed writeup when done. You have full capability: read, write, edit, and execute. Prefer editing existing files; never create documentation files unless explicitly requested. When spawning child agents, choose the narrowest capability that fits the task.',
        toolFilter: { allow: ['run_terminal_cmd', 'read_file', 'search_replace', 'list_dir', 'grep', 'web_search', 'web_fetch', 'todo_write', 'get_task_output', 'kill_task', 'ask_user_question', 'task'] },
      },
      explore: {
        provider: 'grok-explore',
        persona: 'You are the Grok Build "explore" subagent: fast, read-only codebase exploration. You have NO file editing tools. Use list/search/read tool kinds; execute only read-only shell commands (ls, git status, git log, git diff, find, cat, head, tail). Thoroughness: quick | medium | very thorough. Start broad and narrow down; maximize parallel tool calls; return absolute file paths and relevant code snippets.',
        toolFilter: { allow: ['run_terminal_cmd', 'read_file', 'list_dir', 'grep', 'web_search', 'web_fetch'] },
      },
    }
    register(strDef({
      name: 'task',
      // Wording mirrors the stock `subagent` tool (backgroundMode: 'continuable')
      // plus grok's resume-by-agent-id and general-purpose/explore/plan types.
      description: 'Launches a subagent to handle a task autonomously. Provide a complete prompt with all necessary context, because a newly created subagent does not see your current context. subagent_type built-ins: "general-purpose" (default), "explore", "plan". This tool runs in the background by default, immediately returns a durable agent id, and keeps the child conversation available for later turns. When that run settles, the runtime sends a notice containing its outcome and any final assistant message; resume (or send_message) starts a later turn in the same child conversation. Set run_in_background=false only when your next action depends on receiving the result.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The full task prompt for the subagent to execute.' },
          description: { type: 'string', description: 'Short description of the task (3-5 words).' },
          subagent_type: { type: 'string', description: 'Name of the subagent type to launch. Built-in types: "general-purpose", "explore", "plan".', default: 'general-purpose' },
          run_in_background: { type: 'boolean', description: 'Whether to run the subagent in the background and return its agent id immediately. Defaults to true; set false to wait for the result.', default: true },
          resume: { type: 'string', description: 'Optional agent ID of a background subagent to resume instead of creating a new instance; prompt becomes its next turn.' },
          model: { type: 'string', description: 'Optional model slug for this agent.' },
        },
        required: ['prompt', 'description'],
      },
      // Background starts and sibling foreground runs overlap safely under the
      // loop's rolling pool, exactly like the native delegation tool.
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        if (!subagents) return 'Error: subagents service unavailable.'
        if (!exec.agent) return 'Error: no caller agent.'

        // resume: deliver prompt as the existing continuable subagent's next
        // turn (the DSH-standard continuation channel, same as send_message).
        if (args.resume) {
          try {
            const messageId = await subagents.followup(exec.agent, String(args.resume), [{ type: 'text', text: String(args.prompt) }], {
              source: { kind: 'coordinator', form: 'relay', senderSessionId: exec.agent.id },
              signal: exec.signal,
            })
            return 'resumed subagent ' + args.resume + ' — message queued as its next turn (messageId: ' + messageId + '). You will receive a notice when it settles.'
          } catch (e) {
            return 'Error: resume failed: ' + String(e)
          }
        }

        const names = subagents.list()
        // Map grok's built-in subagent types onto the distilled recipes
        // ("plan" shares the general-purpose capability set, as before).
        const spec = GROK_SUBAGENTS[args.subagent_type === 'explore' ? 'explore' : 'general-purpose']
        let providerName = names.indexOf(spec.provider) >= 0 ? spec.provider : (names.indexOf('grok-agent') >= 0 ? 'grok-agent' : (names.indexOf('spawn') >= 0 ? 'spawn' : null))
        if (!providerName) return 'Error: no usable subagent provider (available: ' + (names.join(', ') || 'none') + ').'
        const label = String(args.description).slice(0, 80)
        const request = {
          label,
          prompt: [{ type: 'text', text: String(args.prompt) }],
          parent: exec.agent,
          agentOptions: { provider: 'grok-kernel', model: args.model || 'grok-4.6' },
          persona: spec.persona,
          toolFilter: spec.toolFilter,
          maxDepth: 3,
        }
        // Background (grok's default): native continuable route — resolves at
        // inbox acceptance with a durable agent id; no in-tool wait. The
        // continuable path never invokes provider.start().
        if (args.run_in_background !== false) {
          try {
            const started = await subagents.startContinuable({ provider: providerName, label, request, signal: exec.signal })
            return 'started background subagent ' + started.childId + '. It runs independently; you will receive a notice with its outcome and final message when it settles. Use task with resume="' + started.childId + '" to send it follow-up messages.'
          } catch (e) {
            return 'Error: background start failed: ' + String(e)
          }
        }
        // Foreground override: collect the result and dispose, preserving the
        // child's partial output on a non-completed stop (native semantics).
        const run = await subagents.start(providerName, { ...request, signal: exec.signal })
        try {
          const result = await run.result
          const error = stopReasonError(result)
          if (error !== undefined) return withPartialText(error, result.output)
          return textOf(result.output)
        } finally {
          try { await run.dispose() } catch {}
        }
      },
    }))

    // Native parity: a prompt section teaches the background-first calling
    // convention while the tool is visible (dsh-tool-subagent does the same
    // for `subagent` at order 116.5).
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt) {
      systemPrompt.section({
        name: 'tool:task',
        order: 116.5,
        text: (context) => (tools.get('task', context && context.scope) === undefined ? '' : 'Use task in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set `run_in_background: false` only when your next action depends on that subagent\'s result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message; use task with resume="<id>" to give it more work.'),
      })
    }

    // ---- enter_plan_mode / exit_plan_mode via planMode ----
    if (planMode) {
      register(strDef({
        name: 'enter_plan_mode',
        description: 'Use this tool when a task has ambiguity about the right approach or when the user asks you to write a plan. This tool enables a read-only plan mode where you explore the codebase and create an implementation plan for the user.',
        parameters: { type: 'object', properties: {} },
        execute: async (args, exec) => {
          if (!exec.agent) return 'Error: no caller agent.'
          const outcome = planMode.set(exec.agent, true)
          return 'Plan mode entered (' + outcome + '). You should now focus on exploring the codebase and creating an implementation plan.'
        },
      }))
      register(strDef({
        name: 'exit_plan_mode',
        description: 'Exit plan mode and present your plan to the user. Use this after you have finished writing your plan.',
        parameters: { type: 'object', properties: {} },
        execute: async (args, exec) => {
          if (!exec.agent) return 'Error: no caller agent.'
          const outcome = planMode.set(exec.agent, false)
          return 'Plan mode exited (' + outcome + '). The plan itself should be presented in your response text.'
        },
      }))
    }
}

const _test = { extractGrokSearch, htmlToText, loadGrokKey }
export { name, inject, apply, _test }
