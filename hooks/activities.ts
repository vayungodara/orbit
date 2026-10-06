// Copy of skyline/hooks/activities.ts, so orbit's step icons match the bar. Keep it in sync by copying again.
// What Claude can be doing, as a fixed table: a category (the colour and the group) and a verb
// (the words the bar shows). classify.ts maps every tool call onto one of these ids; keeping the
// table apart from the matching means the words and colours can change without touching a rule.

export type CategoryId =
  | 'think' | 'read' | 'search' | 'edit' | 'test' | 'build' | 'git' | 'github' | 'packages' | 'shell'
  | 'web' | 'browser' | 'x' | 'computer' | 'image' | 'oracle' | 'agents' | 'plan' | 'ask' | 'data' | 'deploy'

/** The tint is a theme key, not a raw colour, so each surface resolves it for its own theme. */
export type Category = { id: CategoryId; tint: string }

export type Activity = { id: string; category: CategoryId; verb: string }

export const CATEGORIES: Record<CategoryId, Category> = {
  think: { id: 'think', tint: 'permission' },
  read: { id: 'read', tint: 'suggestion' },
  search: { id: 'search', tint: 'suggestion' },
  edit: { id: 'edit', tint: 'claude' },
  test: { id: 'test', tint: 'success' },
  build: { id: 'build', tint: 'claude' },
  git: { id: 'git', tint: 'warning' },
  github: { id: 'github', tint: 'warning' },
  packages: { id: 'packages', tint: 'claude' },
  shell: { id: 'shell', tint: 'inactive' },
  web: { id: 'web', tint: 'suggestion' },
  browser: { id: 'browser', tint: 'suggestion' },
  x: { id: 'x', tint: 'claude' },
  computer: { id: 'computer', tint: 'suggestion' },
  image: { id: 'image', tint: 'warning' },
  oracle: { id: 'oracle', tint: 'permission' },
  agents: { id: 'agents', tint: 'permission' },
  plan: { id: 'plan', tint: 'inactive' },
  ask: { id: 'ask', tint: 'error' },
  data: { id: 'data', tint: 'suggestion' },
  deploy: { id: 'deploy', tint: 'warning' },
}

// One line per activity, id → verb, so a search for an id finds its words. The id's prefix is
// its category.
const VERBS: Record<string, string> = {
  'think.request': 'sending request',
  'think.thinking': 'thinking',
  'think.reply': 'writing a reply',
  'read.file': 'reading',
  'read.skim': 'skimming',
  'read.image': 'looking at',
  'read.pdf': 'reading PDF',
  'search.grep': 'searching',
  'search.glob': 'finding files',
  'search.lsp': 'looking up',
  'search.shell': 'searching',
  'edit.file': 'editing',
  'edit.write': 'writing',
  'edit.notebook': 'editing notebook',
  'edit.shell': 'editing',
  'test.run': 'running tests',
  'test.types': 'type-checking',
  'test.lint': 'linting',
  'build.run': 'building',
  'build.format': 'formatting',
  'build.dev': 'starting dev server',
  'git.commit': 'committing',
  'git.diff': 'reading diff',
  'git.status': 'checking status',
  'git.branch': 'switching branch',
  'git.sync': 'syncing',
  'git.rewrite': 'rewriting history',
  'github.create': 'opening PR',
  'github.read': 'reading GitHub',
  'github.ci': 'checking CI',
  'github.comment': 'commenting',
  'github.merge': 'merging PR',
  'packages.install': 'installing packages',
  'shell.run': 'running',
  'shell.files': 'moving files',
  'shell.delete': 'deleting files',
  'shell.read': 'reading',
  'shell.process': 'checking processes',
  'shell.media': 'converting media',
  'web.search': 'searching the web',
  'web.fetch': 'reading',
  'web.docs': 'reading docs',
  'browser.navigate': 'browsing',
  'browser.interact': 'clicking around',
  'browser.inspect': 'inspecting page',
  'x.search': 'searching X',
  'x.read': 'reading post',
  'x.thread': 'reading thread',
  'x.user': 'reading',
  'x.feed': 'scrolling X',
  'computer.codex': 'using the computer',
  'computer.drive': 'driving',
  'computer.sim': 'testing on simulator',
  'image.paint': 'painting',
  'oracle.ask': 'consulting the oracle',
  'agents.spawn': 'briefing',
  'agents.workflow': 'running a workflow',
  'agents.message': 'messaging an agent',
  'plan.todo': 'planning',
  'plan.skill': 'loading skill',
  'plan.tools': 'loading tools',
  'ask.question': 'waiting for you',
  'data.db': 'querying database',
  'data.docs': 'reading docs',
  'data.mail': 'checking mail',
  'data.calendar': 'checking calendar',
  'deploy.ship': 'deploying',
  'deploy.publish': 'publishing page',
  // The last resort when nothing matches: a tool the table has never heard of.
  'other.tool': 'using',
}

function build(): Record<string, Activity> {
  const table: Record<string, Activity> = {}
  for (const [id, verb] of Object.entries(VERBS)) {
    const prefix = id.split('.')[0] ?? ''
    table[id] = { id, category: prefix === 'other' ? 'shell' : (prefix as CategoryId), verb }
  }

  return table
}

export const ACTIVITIES: Record<string, Activity> = build()
