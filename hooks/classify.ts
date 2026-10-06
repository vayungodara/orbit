// Copy of skyline/hooks/classify.ts, so orbit's step icons match the bar. Keep it in sync by copying again.
// Turns a tool call into one activity id from activities.ts and a short target ("app.ts", "#2",
// "\"useEffect\"") for the bar. Pure and total: any input gets an activity, never an exception,
// and every target is cut to 32 characters in one place, at the end of classify.

export type Classified = { activity: string; target: string }

type Args = string[]
// An activity and its target: a fixed string, read from the words after the matched command,
// or, when left out, the command's own name ("tsc", "cargo").
type Rule = [activity: string, target?: string | ((args: Args) => string)]

const MAX = 32
// Prompts and tasks are prose, so only their first 20 characters show, then an ellipsis.
const GIST = 21

function clip(text: string, max = MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

function host(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

const str = (value: unknown) => (typeof value === 'string' ? value : '')
const quote = (text: string) => (text ? `"${clip(text, MAX - 2)}"` : '')
const basename = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? ''

const operands = (args: Args) => args.filter(arg => !arg.startsWith('-'))
const first = (args: Args) => operands(args)[0] ?? ''
const second = (args: Args) => operands(args)[1] ?? ''
const last = (args: Args) => operands(args).at(-1) ?? ''
const file = (args: Args) => basename(last(args))
const pattern = (args: Args) => quote(first(args))
const url = (args: Args) => host(args.find(arg => /^https?:\/\//.test(arg)) ?? '')

function pr(args: Args): string {
  const number = operands(args).find(arg => /^\d+$/.test(arg))

  return number ? `#${number}` : ''
}

// Shell commands by their first one to three words; the longest match wins, so `gh pr merge`
// beats `gh`.
const COMMANDS: Record<string, Rule> = {
  'cargo test': ['test.run'],
  'go test': ['test.run'],
  'swift test': ['test.run'],
  'claude plugin test': ['test.run', 'claude plugin'],
  pytest: ['test.run'],
  vitest: ['test.run'],
  jest: ['test.run'],
  tsc: ['test.types'],
  mypy: ['test.types'],
  'cargo check': ['test.types'],
  'claude plugin validate': ['test.lint', 'validate'],
  'cargo clippy': ['test.lint', 'clippy'],
  eslint: ['test.lint'],
  ruff: ['test.lint'],
  swiftc: ['build.run'],
  make: ['build.run'],
  xcodebuild: ['build.run'],
  'cargo build': ['build.run'],
  'go build': ['build.run'],
  'swift build': ['build.run'],
  'cargo fmt': ['build.format', 'cargo fmt'],
  prettier: ['build.format'],
  gofmt: ['build.format'],
  'git commit': ['git.commit', ''],
  'git add': ['git.commit', ''],
  'git diff': ['git.diff', ''],
  'git show': ['git.diff', ''],
  'git status': ['git.status', ''],
  'git log': ['git.status', ''],
  'git checkout': ['git.branch', last],
  'git switch': ['git.branch', last],
  'git push': ['git.sync', second],
  'git pull': ['git.sync', second],
  'git fetch': ['git.sync', second],
  'git rebase': ['git.rewrite', ''],
  'git reset': ['git.rewrite', ''],
  'git cherry-pick': ['git.rewrite', ''],
  'gh pr create': ['github.create', ''],
  'gh pr checks': ['github.ci', pr],
  'gh run': ['github.ci', ''],
  'gh pr comment': ['github.comment', pr],
  'gh pr merge': ['github.merge', pr],
  gh: ['github.read', pr],
  'brew install': ['packages.install', first],
  'pip install': ['packages.install', first],
  'uv add': ['packages.install', first],
  'cargo add': ['packages.install', first],
  rm: ['shell.delete', file],
  mv: ['shell.files', ''],
  cp: ['shell.files', ''],
  rsync: ['shell.files', ''],
  mkdir: ['shell.files', ''],
  cat: ['shell.read', file],
  head: ['shell.read', file],
  tail: ['shell.read', file],
  sed: ['shell.read', file],
  rg: ['search.shell', pattern],
  grep: ['search.shell', pattern],
  find: ['search.shell', ''],
  ps: ['shell.process', ''],
  pgrep: ['shell.process', ''],
  pkill: ['shell.process', ''],
  lsof: ['shell.process', ''],
  ffmpeg: ['shell.media'],
  magick: ['shell.media'],
  sips: ['shell.media'],
  curl: ['web.fetch', url],
  wget: ['web.fetch', url],
  'xfree search': ['x.search', pattern],
  'xfree read': ['x.read', ''],
  'xfree thread': ['x.thread', ''],
  'xfree user': ['x.user', first],
  'xfree home': ['x.feed', ''],
  'xfree mentions': ['x.feed', ''],
  'wrangler deploy': ['deploy.ship'],
  vercel: ['deploy.ship'],
  supabase: ['data.db'],
  psql: ['data.db'],
  sqlite3: ['data.db'],
}

// The JavaScript package managers share their verbs.
// ponytail: scripts match by exact name, so `npm run test:unit` falls through to running npm;
// match script names by prefix if that shows up.
for (const pm of ['npm', 'pnpm', 'yarn', 'bun']) {
  COMMANDS[`${pm} test`] = ['test.run']
  COMMANDS[`${pm} run test`] = ['test.run']
  COMMANDS[`${pm} run lint`] = ['test.lint']
  COMMANDS[`${pm} run build`] = ['build.run']
  COMMANDS[`${pm} run dev`] = ['build.dev']
  COMMANDS[`${pm} install`] = ['packages.install', first]
  COMMANDS[`${pm} add`] = ['packages.install', first]
}

// The words of one shell command, quotes removed, and the file its stdout is redirected into.
// Redirections (`> f`, `2>/dev/null`, `<<'EOF'`) are found before quotes come off, so a quoted
// `"<Button"` stays a word, and they leave with their target so it never reads as an argument.
// Also dropped is what only changes how the real command runs: `FOO=1 sudo make` is make and
// `npx -y tsc` is tsc.
function words(segment: string): [Args, string] {
  const raw = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  const all: Args = []
  let written = ''
  for (let i = 0; i < raw.length; i++) {
    const word = raw[i] ?? ''
    const [isRedirect, fd = '', op = '', joined = ''] = /^(\d*|&)(>\||>>?|<{1,3})(.*)$/.exec(word) ?? []
    if (!isRedirect) {
      all.push(word.replace(/^["']|["']$/g, ''))
      continue
    }
    if (!joined) i++
    const target = (joined || raw[i] || '').replace(/^["']|["']$/g, '')
    // Only stdout into a real file is a write; `>&2` and `>/dev/null` write nothing.
    if (!written && /^(1?|&)$/.test(fd) && op.startsWith('>') && !/^(&|\/dev\/)/.test(target)) written = target
  }
  while (/^(sudo|time|nohup|env|npx|bunx|-.*|\w+=.*)$/.test(all[0] ?? '')) all.shift()

  return [all, written]
}

// ponytail: a naive tokeniser, not a shell parser. It splits on && || ; | even inside quotes
// (`rg "a|b"` loses "|b"), ignores line continuations and `git -C dir` global options (that
// reads as running git). Upgrade to a quote-aware scanner if targets come out wrong in use.
function byCommand(command: string): [string, string] {
  const segments = (command.slice(0, 2000).split('\n')[0] ?? '').split(/&&|\|\||;|(?<!>)\|/).map(words)
  const [chosen, written] = segments.find(([segment]) => !/^(cd|export|set|source|\.)?$/.test(segment[0] ?? '')) ?? segments[0] ?? [[], '']
  const [name = '', ...args] = chosen
  // cat, echo and printf only print, so a stdout redirect means they write a file: `cat > a.ts
  // <<'EOF'`, `echo hi >> log`. Other commands keep their own label (`npm test > out.log` is still
  // running tests).
  if (/^(cat|echo|printf)$/.test(name) && written) return ['edit.shell', basename(written)]
  if (name === 'sed' && args.some(arg => arg.startsWith('-i'))) return ['edit.shell', file(args)]
  for (let n = Math.min(3, chosen.length); n > 0; n--) {
    const key = chosen.slice(0, n).join(' ')
    if (!Object.hasOwn(COMMANDS, key)) continue
    const [activity, target = name] = COMMANDS[key] ?? ['shell.run']

    return [activity, typeof target === 'string' ? target : target(chosen.slice(n))]
  }

  return ['shell.run', name]
}

function byTool(tool: string, input: Record<string, unknown>): [string, string] {
  const path = str(input.file_path)
  switch (tool) {
    case 'Bash':
      return byCommand(str(input.command))
    case 'Read':
      if (/\.pdf$/i.test(path) || input.pages !== undefined) return ['read.pdf', basename(path)]
      if (/\.(png|jpe?g|gif|webp|svg)$/i.test(path)) return ['read.image', basename(path)]
      return [input.offset !== undefined || input.limit !== undefined ? 'read.skim' : 'read.file', basename(path)]
    case 'Grep':
      return ['search.grep', quote(str(input.pattern))]
    case 'Glob':
      return ['search.glob', str(input.pattern)]
    case 'LSP':
      return ['search.lsp', basename(str(input.filePath))]
    case 'Edit':
      return ['edit.file', basename(path)]
    case 'Write':
      return ['edit.write', basename(path)]
    case 'NotebookEdit':
      return ['edit.notebook', basename(str(input.notebook_path))]
    case 'WebSearch':
      return ['web.search', quote(str(input.query))]
    case 'WebFetch':
      return ['web.fetch', host(str(input.url))]
    case 'Agent':
      return ['agents.spawn', str(input.subagent_type)]
    case 'Workflow':
      return ['agents.workflow', '']
    case 'SendMessage':
      return ['agents.message', '']
    case 'TodoWrite':
      return ['plan.todo', '']
    case 'Skill':
      return ['plan.skill', str(input.skill).split(':').pop() ?? '']
    case 'ToolSearch':
      return ['plan.tools', '']
    case 'AskUserQuestion':
      return ['ask.question', '']
    case 'Artifact':
      return ['deploy.publish', '']
  }

  // MCP tools are mcp__<server>__<name>; most are known by their server, the rest by their name.
  const [, server = '', name = tool] = /^mcp__(.+?)__(.+)$/.exec(tool) ?? []
  if (server === 'exa') {
    const urls = Array.isArray(input.urls) ? str(input.urls[0]) : ''
    return name.includes('fetch') ? ['web.fetch', host(str(input.url) || urls)] : ['web.search', quote(str(input.query))]
  }
  if (name === 'query-docs' || name === 'resolve-library-id') return ['web.docs', str(input.libraryId) || str(input.libraryName)]
  if (/^(claude-in-chrome|Claude_Browser|chrome-devtools)$/.test(server)) {
    if (/^(navigate(_page)?|new_page|tabs_create.*|preview_start)$/.test(name)) return ['browser.navigate', host(str(input.url))]
    return [/^(get_page_text|find|take_.*|read_.*|list_.*|javascript.*|evaluate_script)$/.test(name) ? 'browser.inspect' : 'browser.interact', '']
  }
  if (server === 'oracle') return name === 'computer' ? ['computer.codex', clip(str(input.task), GIST)] : ['oracle.ask', '']
  if (server === 'plugin_oracle_cua' || server === 'computer-use') return ['computer.drive', /getApp\(["'](.+?)["']\)/.exec(str(input.code))?.[1] ?? '']
  if (server === 'Claude_Code_iOS_Simulator') return ['computer.sim', '']
  if (server === 'image') return ['image.paint', clip(str(input.prompt), GIST)]
  if (/^(query_logs|execute_sql|list_tables)$/.test(name) || server.includes('supabase')) return ['data.db', '']
  if (/^(notion-.*|read_file_content|search_files|list_recent_files|get_file_metadata)$/.test(name)) return ['data.docs', '']
  if (/^(send_message|reply|forward|.*_thread|.*_draft|.*_label)$/.test(name)) return ['data.mail', '']
  if (/calendar|event/.test(name)) return ['data.calendar', '']

  return ['other.tool', name]
}

export function classify(tool: string, input: Record<string, unknown>): Classified {
  const [activity, target] = byTool(tool, input ?? {})

  return { activity, target: clip(target) }
}

export function classifyCommand(command: string): Classified {
  return classify('Bash', { command })
}
