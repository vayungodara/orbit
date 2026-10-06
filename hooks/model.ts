// Pure readers of Amp's CLI output and the rules for an orb's state. No `$` here, so each
// rule is tested on its own.
import type { Orb, OrbCheck, OrbPr, OrbSize, OrbState, OrbStep } from '../types'
import { stepOf } from './steps'

export const QUIET_MS = 90_000
export const STALE_MS = 86_400_000
const MAX_STEPS = 6
const MAX_FINAL = 4000
const ORB_TREE = 'file:///home/user/workspace'

export type ListRow = { id: string; title: string; updatedAt: number; messageCount: number; isOrb: boolean }

export function parseList(stdout: string): ListRow[] {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    throw new Error('amp threads list did not answer JSON')
  }
  if (!Array.isArray(raw)) throw new Error('amp threads list did not answer a list')

  return raw.flatMap((row): ListRow[] => {
    if (!row || typeof row !== 'object') return []
    const r = row as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id : ''
    if (!/^T-[0-9a-f-]{8,}$/.test(id)) return []
    const updatedAt = Date.parse(String(r.updated ?? ''))

    return [{
      id,
      title: typeof r.title === 'string' && r.title ? r.title : id,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      messageCount: Number(r.messageCount ?? 0) || 0,
      isOrb: typeof r.tree === 'string' && r.tree.startsWith(ORB_TREE),
    }]
  })
}

type Block = Record<string, unknown>
type Message = { role?: string; state?: { type?: string; stopReason?: string }; content?: unknown }

const blocks = (m: Message): Block[] => (Array.isArray(m.content) ? (m.content as unknown[]).filter((b): b is Block => !!b && typeof b === 'object') : [])

function isFailedRun(run: unknown): boolean {
  if (!run || typeof run !== 'object') return false
  const r = run as Record<string, unknown>

  return r.status === 'error' || (r.error !== undefined && r.error !== null)
}

export type ExportView = { agentState: string; mode: string | null; createdAt: number; steps: OrbStep[]; prs: OrbPr[]; finalText: string; isEnded: boolean; isErrored: boolean }

export function parseExport(stdout: string): ExportView {
  const d = JSON.parse(stdout) as Record<string, unknown>
  const meta = (d.meta ?? {}) as Record<string, unknown>
  const agent = (meta.lastKnownAgentState ?? {}) as Record<string, unknown>
  const agentState = String(agent.state ?? '')
  const messages = Array.isArray(d.messages) ? (d.messages as Message[]) : []
  const results = new Map<string, boolean>()
  for (const m of messages) {
    for (const b of blocks(m)) {
      if (b.type === 'tool_result' && typeof b.toolUseID === 'string') results.set(b.toolUseID, !isFailedRun(b.run))
    }
  }
  const assistant = messages.filter(m => m.role === 'assistant')
  const uses = assistant.flatMap(m => blocks(m).filter(b => b.type === 'tool_use'))
  const steps = uses.slice(-MAX_STEPS).map(b => stepOf(String(b.name ?? ''), (b.input ?? {}) as Record<string, unknown>, String(b.id ?? ''), results))
  const last = assistant[assistant.length - 1]
  const textOf = (m: Message) => blocks(m).filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('\n')
  const finalText = last ? textOf(last).trim() : ''
  // The agent has the last word only when the thread's last row is its own. A user row after it
  // (a follow-up, a fresh orb's prompt, tool results) is a turn under way, whatever the lagging
  // agent state or the previous turn's end_turn say. Rows of other roles do not count.
  const turnRows = messages.filter(m => m.role === 'user' || m.role === 'assistant')
  const isAgentLast = turnRows[turnRows.length - 1]?.role === 'assistant'

  return {
    agentState,
    mode: typeof d.agentMode === 'string' ? d.agentMode : null,
    createdAt: Number(d.created ?? 0) || 0,
    steps,
    prs: prLinks(assistant.map(textOf).join('\n')),
    finalText: finalText.length > MAX_FINAL ? `…${finalText.slice(-MAX_FINAL)}` : finalText,
    isEnded: isAgentLast && (last?.state?.stopReason === 'end_turn' || agentState === 'idle'),
    // An error counts only for the turn it ended: after a follow-up it is the last turn's news.
    isErrored: isAgentLast && (last?.state?.type === 'error' || /error|fail/i.test(agentState)),
  }
}

const PR = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g

export function prLinks(text: string): OrbPr[] {
  const seen = new Map<string, OrbPr>()
  for (const m of text.matchAll(PR)) {
    const url = `https://github.com/${m[1]}/pull/${m[2]}`
    if (!seen.has(url)) seen.set(url, { url, repo: m[1]!, number: Number(m[2]), state: 'unknown', ci: 'none', review: 'none' })
  }

  return [...seen.values()]
}

export function endsWithQuestion(text: string): boolean {
  const flat = text.trim().replace(/[*_`\s]+$/, '')
  const last = flat.split(/(?<=[.!?])\s+/).pop() ?? ''

  return last.trim().endsWith('?')
}

export type StateInput = Pick<Orb, 'agentState' | 'isEnded' | 'isErrored' | 'finalText' | 'changedAt' | 'exportedAt'> & { isListOnly?: boolean }

export function stateOf(o: StateInput, now: number): OrbState {
  if (now - o.changedAt > STALE_MS) return 'stale'
  // The one orb that is not working before its first read: it was quiet for over an hour when first seen.
  if (o.isListOnly) return 'done'
  // Only a reading of the thread taken since its last change can end a turn: until one lands (or
  // while it keeps failing) the orb is working, however long the change has been quiet.
  if (o.exportedAt < o.changedAt) return 'working'
  if (o.isErrored) return 'failed'
  // A turn that has not ended is working, whatever the agent state says.
  if (!o.isEnded) return 'working'

  return endsWithQuestion(o.finalText) ? 'waiting' : 'done'
}

function prefixOf(title: string): string {
  return /^[^:]{2,40}:\s/.exec(title)?.[0] ?? ''
}

export function shortTitles(titles: readonly string[]): string[] {
  const counts = new Map<string, number>()
  for (const t of titles) {
    const p = prefixOf(t)
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1)
  }

  return titles.map(t => {
    const p = prefixOf(t)

    return p && (counts.get(p) ?? 0) >= 2 ? t.slice(p.length).trim() : t
  })
}

export function sizeOfCores(cores: number | null): OrbSize | null {
  return cores === 2 ? 'a1.small' : cores === 4 ? 'a1.medium' : cores === 8 ? 'a1.large' : null
}

// A PR check's mark, in the pane and in orb_status.
export const MARK: Record<OrbCheck, string> = { pass: '✓', fail: '✗', pending: '…', none: '–' }

// Line colours for the globe, picked by thread id so an orb keeps its colour.
const TINTS = ['#7dd3c0', '#b1b9f9', '#f0a6ca', '#f5c97a', '#9ad1f5', '#c3e88d']

export function tintFor(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0

  return TINTS[h % TINTS.length]!
}

export type UsageView = { cost: string; cpu: number[]; memMiB: number[]; cores: number | null; memTotalMiB: number | null }

export function parseUsage(text: string): UsageView {
  const cost = /^Cost:\s*(\S+)/m.exec(text)?.[1] ?? ''
  const cpu: number[] = []
  const memMiB: number[] = []
  let cores: number | null = null
  let memTotalMiB: number | null = null
  for (const m of text.matchAll(/^\|\s*([\d.]+)% \/ (\d+) cores \|\s*(\d+) MiB \/ (\d+) MiB/gm)) {
    cpu.push(Number(m[1]))
    memMiB.push(Number(m[3]))
    cores = Number(m[2])
    memTotalMiB = Number(m[4])
  }

  return { cost, cpu: cpu.slice(-40), memMiB: memMiB.slice(-40), cores, memTotalMiB }
}

export function blankOrb(id: string): Orb {
  return {
    id, title: id, url: `https://ampcode.com/threads/${id}`, size: null, mode: null, state: 'working',
    createdAt: 0, updatedAt: 0, changedAt: 0, messageCount: 0, steps: [], prs: [], finalText: '',
    agentState: '', isEnded: false, isErrored: false, exportedAt: 0, seenTurn: '', isStartedHere: false, isListOnly: false,
  }
}
