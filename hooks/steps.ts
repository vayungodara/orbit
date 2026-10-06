// Turns one Amp tool call into a step for the drawer: skyline's activity table gives the
// category (colour and icon) and verb, and shell commands go through skyline's own classifier.
import type { OrbStep } from '../types'
import { ACTIVITIES } from './activities'
import { classifyCommand } from './classify'

const BY_TOOL: Record<string, string> = {
  apply_patch: 'edit.file',
  edit_file: 'edit.file',
  create_file: 'edit.write',
  Read: 'read.file',
  read_file: 'read.file',
  finder: 'search.grep',
  Grep: 'search.grep',
  glob: 'search.glob',
  tool_search: 'plan.tools',
  skill: 'plan.skill',
  todo_write: 'plan.todo',
  web_search: 'web.search',
  read_web_page: 'web.fetch',
  Task: 'agents.spawn',
  code_exec: 'shell.run',
  shell_command_status: 'shell.process',
}
const MAX = 32
const FALLBACK = ACTIVITIES['other.tool']!

const str = (value: unknown) => (typeof value === 'string' ? value : '')

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const points = [...flat]

  return points.length > MAX ? `${points.slice(0, MAX - 1).join('').trimEnd()}…` : flat
}

function patchTarget(patch: string): string {
  const found = /\*\*\* (?:Update|Add|Delete) File: (\S+)/.exec(patch)?.[1] ?? ''

  return found.split('/').pop() ?? found
}

export function stepOf(tool: string, input: Record<string, unknown>, id: string, results: ReadonlyMap<string, boolean>): OrbStep {
  let activity = BY_TOOL[tool] ?? 'other.tool'
  let target = ''
  if (tool === 'shell_command') {
    const classified = classifyCommand(str(input.command) || str(input.cmd))
    activity = classified.activity
    target = classified.target
  } else if (tool === 'apply_patch') {
    target = patchTarget(str(input.patch) || str(input.input))
  } else if (tool === 'skill') {
    target = str(input.name)
  } else if (tool === 'Task') {
    target = str(input.description) || str(input.prompt)
  } else if (tool === 'finder' || tool === 'Grep') {
    target = str(input.query) || str(input.pattern)
  } else if (activity === 'other.tool') {
    target = tool
  }
  const known = ACTIVITIES[activity] ?? FALLBACK

  return { id, category: known.category, verb: known.verb, target: clip(target), isRunning: !results.has(id), isOk: results.get(id) ?? true }
}
