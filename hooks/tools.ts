// Claude's native orb tools. They share the poller's cache. Waits sleep in a host `sleep` process,
// because a `$.clock.sleep` would count against the hook's own time budget.
// It takes a `Ports` instead of `$`: the engine follows `$` only inside the file that holds it, so
// register.tsx serves these with `serveTool(portsOf($), e, next.signal)`.
import type { Orb } from '../types'
import { pressArchive, sendMessage } from './actions'
import { ampExport, ampStart, isThreadId, StartUnsure } from './cli'
import { blankOrb, MARK, parseExport, shortTitles } from './model'
import { addStarted, pollNow, want } from './poller'
import type { Ports } from './ports'
import { WATCH_MS } from './scheduler'

const MODES = ['low', 'medium', 'high', 'ultra']
const SIZES = ['a1.small', 'a1.medium', 'a1.large']
const UNTIL = ['idle', 'pr', 'any']
// A wait's step is one tiny `sleep` process, short enough that a cancelled call is noticed inside
// the engine's linger. The poller owns every Amp read: a wait only asks it to keep its watched
// cadence going (`want`), so waiting adds no reads of its own.
const WAIT_STEP_MS = 5_000
const WAIT_DEFAULT_MIN = 30
const WAIT_MAX_MIN = 120
// A read this fresh answers a status call or an archive without another one.
const FRESH_MS = 15_000
// orb_status lists, by default, the orbs that are active or changed this recently.
const RECENT_MS = 3_600_000
// The most of a stopped orb's last message orb_status shows, and of a report orb_result returns.
const TAIL = 160
const RESULT_MAX = 3_000
const MAX_PRS = 3
// Plugin tools answered in a hook never reach the engine's permission prompt, so these three, which
// change something, run only on an explicit allow. The read-only tools stop only on an explicit deny.
const GATED = ['orb_start', 'orb_send', 'orb_archive']

type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> }
type Served = { result: string } | { deny: string }

// What Claude reads on every turn of every session, so each word earns its place.
const STR = { type: 'string' }
const IDS = { type: 'array' }
const object = (properties: Record<string, unknown>, ...required: string[]) => ({ type: 'object', properties, ...(required.length ? { required } : {}) })
const ONE = object({ id: STR }, 'id')

export const TOOLS: ToolSpec[] = [
  { name: 'orb_start', description: 'Start an Amp orb on project owner/name. Defaults: mode ultra, size a1.small. Put the whole task in prompt.', inputSchema: object({ title: STR, prompt: STR, project: STR, mode: { enum: MODES }, size: { enum: SIZES } }, 'title', 'prompt', 'project') },
  { name: 'orb_send', description: 'Message an orb.', inputSchema: object({ id: STR, message: STR }, 'id', 'message') },
  { name: 'orb_status', description: 'Orbs active or changed in the last hour; all: every orb. URL ampcode.com/threads/<id>', inputSchema: object({ ids: IDS, all: { type: 'boolean' } }) },
  { name: 'orb_wait', description: `Wait until orbs are idle (default), each has a new pr, or any ends a turn or opens a PR. Default ${WAIT_DEFAULT_MIN} min, max ${WAIT_MAX_MIN}.`, inputSchema: object({ ids: IDS, until: { enum: UNTIL }, timeoutMinutes: { type: 'number' } }, 'ids') },
  { name: 'orb_result', description: "An orb's final message.", inputSchema: ONE },
  { name: 'orb_archive', description: 'Archive an orb.', inputSchema: ONE },
]

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

// One line per orb: the id (the other tools need it), what it is doing or how it ended, its PRs.
function lineOf(o: Orb, title: string): string {
  const step = o.state === 'working' ? o.steps[o.steps.length - 1] : undefined
  // Marks only for a PR gh has checked: one never checked (state unknown) is its number alone.
  const prs = o.prs.slice(0, MAX_PRS).map(pr => (pr.state === 'unknown' ? `#${pr.number}` : pr.state === 'open' ? `#${pr.number} CI${MARK[pr.ci]} CR${MARK[pr.review]}` : `#${pr.number} ${pr.state}`))
  const flat = o.state === 'working' ? '' : o.finalText.replace(/\s+/g, ' ').trim()

  return [
    `${o.id} ${title.replace(/\s+/g, ' ').trim()}`,
    o.state,
    [o.mode, o.size?.replace('a1.', '')].filter(Boolean).join('/'),
    step ? `${step.verb} ${step.target}`.trim() : '',
    prs.length ? `PR ${prs.join(', ')}${o.prs.length > MAX_PRS ? ` +${o.prs.length - MAX_PRS}` : ''}` : '',
    flat ? `"${flat.length > TAIL ? `…${flat.slice(1 - TAIL).trimStart()}` : flat}"` : '',
  ].filter(Boolean).join(' · ')
}

async function statusText(p: Ports, o: { ids?: readonly string[]; all?: boolean } = {}): Promise<string> {
  const now = await p.now()
  const orbs = await p.orbs.get()
  const titles = shortTitles(orbs.map(x => x.title))
  const isShown = (x: Orb) => (o.ids?.length ? o.ids.includes(x.id) : o.all || ['working', 'waiting', 'failed'].includes(x.state) || now - x.changedAt < RECENT_MS)
  const lines = orbs.flatMap((x, i) => (isShown(x) ? [lineOf(x, titles[i] ?? x.title)] : []))
  const error = await p.error.get()
  if (error) lines.unshift(`amp failing: ${error.text}`)

  return lines.join('\n') || (orbs.length ? `no orbs to show (${orbs.length} tracked; all: true lists them)` : 'no orbs tracked')
}

// `seenWorking` holds every orb seen working since the wait began, so `any` also catches a turn
// that started during the wait (a message sent from the pane, or by Claude just before).
type Baseline = { prs: Map<string, number>; seenWorking: Set<string> }

function isMet(until: string, orbs: readonly Orb[], wanted: readonly string[], before: Baseline): boolean {
  const mine = wanted.map(id => orbs.find(o => o.id === id))
  const hasNewPr = (o: Orb) => o.prs.length > (before.prs.get(o.id) ?? 0)
  if (until === 'pr') return mine.every(o => !!o && hasNewPr(o))
  if (until === 'any') return mine.some(o => !!o && (hasNewPr(o) || (before.seenWorking.has(o.id) && o.state !== 'working')))

  return mine.every(o => !!o && o.state !== 'working')
}

async function denial(p: Ports, e: Record<string, unknown>, tool: string): Promise<string | null> {
  const input = Object.fromEntries(Object.entries(e).filter(([key]) => key !== 'tool' && key !== 'tool_use_id'))
  const rule = `Add mcp__orbit__${tool} (or mcp__orbit__*) to your allow rules.`
  let decision: string
  try {
    const check = await p.checkTool(String(e.tool), input)
    if (check.decision === 'deny') return `orbit: ${check.reason ?? 'denied by permission settings'}`
    decision = check.decision
  } catch (error) {
    // A check that cannot answer does not stop a read-only tool, and never lets a gated one through.
    return GATED.includes(tool) ? `orbit: ${tool} was not run, its permission check failed (${reason(error)}). ${rule}` : null
  }

  return GATED.includes(tool) && decision !== 'allow' ? `orbit: ${tool} needs permission. ${rule}` : null
}

// Every read in one hook run sees one moment, however long the run lasts, and only a write of the
// run's own moves it on (`$.state.get`). A wait sleeps between reads, so it would never see what the
// poller's timer found meanwhile. Writing the list back unchanged hands back the list as it stands now.
const current = (p: Ports) => p.orbs.set(list => list)

// Resolves when the call is cancelled. A signal that cannot be listened to is still checked by
// `aborted` at every step, so a cancel is then noticed at the next one.
function onAbort(signal: AbortSignal): { aborted: Promise<void>; off: () => void } {
  let off = () => {}
  const aborted = new Promise<void>(resolve => {
    if (signal.aborted) return resolve()
    if (typeof signal.addEventListener !== 'function') return
    const listener = () => resolve()
    signal.addEventListener('abort', listener, { once: true })
    off = () => signal.removeEventListener?.('abort', listener)
  })

  return { aborted, off: () => off() }
}

async function wait(p: Ports, e: Record<string, unknown>, signal: AbortSignal): Promise<Served> {
  const given = list(e.ids)
  const wanted = given.filter(isThreadId)
  if (wanted.length === 0 || wanted.length < given.length) return { deny: 'orb_wait: ids must list Amp thread ids like T-01a1…' }
  const until = e.until === undefined ? 'idle' : str(e.until)
  if (!UNTIL.includes(until)) return { deny: `orb_wait: until must be one of ${UNTIL.join(', ')}` }
  const minutes = Math.min(WAIT_MAX_MIN, Math.max(1, Number(e.timeoutMinutes ?? WAIT_DEFAULT_MIN) || WAIT_DEFAULT_MIN))
  const deadline = (await p.now()) + minutes * 60_000
  // The baseline is what was known before this wait read Amp, so a PR the first read finds counts as new.
  const first = await p.orbs.get()
  const before: Baseline = { prs: new Map(first.map(o => [o.id, o.prs.length])), seenWorking: new Set(first.filter(o => o.state === 'working').map(o => o.id)) }
  const stopped = async (why: string) => ({ result: `${why}\n${await statusText(p, { ids: wanted })}` })
  const cancel = onAbort(signal)
  try {
    // The one read the wait asks for, and only when the cache is older than the watched cadence.
    if (!signal.aborted) await pollNow(p, WATCH_MS)
    for (;;) {
      if (signal.aborted) return await stopped('stopped waiting.')
      // Keeps the poller's 30 second cadence alive; it lapses about a minute after the wait ends.
      await want(p, 2 * WATCH_MS)
      const orbs = await current(p)
      if (isMet(until, orbs, wanted, before)) return { result: await statusText(p, { ids: wanted }) }
      for (const o of orbs) if (o.state === 'working') before.seenWorking.add(o.id)
      // The read that just landed either failed or listed what Amp has: say so now, not at the timeout.
      const error = await p.error.get()
      // The status below leads with the error itself.
      if (error) return await stopped('stopped waiting: Amp could not be read.')
      const missing = wanted.filter(id => !orbs.some(o => o.id === id))
      if (until === 'any' ? missing.length === wanted.length : missing.length > 0) {
        return await stopped(`stopped waiting: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not tracked (not in Amp's recent orbs, or archived).`)
      }
      const now = await p.now()
      if (now >= deadline) return await stopped(`timed out after ${minutes} min.`)
      if (signal.aborted) return await stopped('stopped waiting.')
      // The last step is cut to the time left, so a wait does not overrun its deadline.
      const stepMs = Math.min(WAIT_STEP_MS, deadline - now)
      const slept = p
        .run(['sleep', String(stepMs / 1000)], { timeoutMs: stepMs + 10_000 })
        .then(out => (out.exitCode === 0 ? null : `sleep exited ${out.exitCode}`), error => reason(error))
      // A cancel ends the step at once; the `sleep` process is left to finish by itself.
      const outcome = await Promise.race([slept, cancel.aborted.then(() => 'cancelled' as const)])
      // Without a working sleep this would spin until the deadline: say so and stop instead.
      if (outcome !== null && outcome !== 'cancelled') return await stopped(`stopped waiting: ${outcome}.`)
    }
  } finally {
    cancel.off()
  }
}

export async function serveTool(p: Ports, e: Record<string, unknown>, signal: AbortSignal): Promise<Served> {
  const tool = String(e.tool).replace('mcp__orbit__', '')
  const denied = await denial(p, e, tool)
  if (denied) return { deny: denied }

  if (tool === 'orb_start') {
    const title = str(e.title)
    const prompt = str(e.prompt)
    const project = str(e.project)
    const mode = str(e.mode) || 'ultra'
    const size = str(e.size) || 'a1.small'
    if (!title || !prompt || !project) return { deny: 'orb_start: title, prompt and project are required' }
    if (!MODES.includes(mode)) return { deny: `orb_start: mode must be one of ${MODES.join(', ')}` }
    if (!SIZES.includes(size)) return { deny: `orb_start: size must be one of ${SIZES.join(', ')}` }
    let started
    try {
      started = await ampStart(p, { title, prompt, project, mode, size })
    } catch (error) {
      if (!(error instanceof StartUnsure)) throw error
      // amp ran, so an orb may be up: say so, rather than a plain error that invites a second one.
      await want(p)
      const seen = error.urls.length > 0 ? ` amp printed: ${error.urls.join(' ')}` : ''

      return { result: `orb_start: the orb may have started; check orb_status before retrying (${error.message}).${seen}` }
    }
    const now = await p.now()
    await addStarted(p, { ...blankOrb(started.id), title, mode, size: size as Orb['size'], createdAt: now, updatedAt: now, changedAt: now, isStartedHere: true })
    await want(p)

    return { result: `Started ${started.id} (${mode}, ${size}): ${started.url}. orbit is watching it; use orb_wait to wait for it.` }
  }

  if (tool === 'orb_send' || tool === 'orb_result' || tool === 'orb_archive') {
    const id = str(e.id)
    if (!isThreadId(id)) return { deny: `${tool}: id must be an Amp thread id like T-01a1…` }
    if (tool === 'orb_send') {
      const message = str(e.message)
      if (!message) return { deny: 'orb_send: message is empty' }
      const sent = await sendMessage(p, id, message)

      return sent === 'sent' ? { result: `sent to ${id}` } : { deny: `orb_send: ${sent} to ${id}` }
    }
    if (tool === 'orb_result') {
      const view = parseExport(await ampExport(p, id))
      if (!view.finalText) return { result: '(no final message yet)' }
      const text = view.finalText.length > RESULT_MAX ? `(the last ${RESULT_MAX} characters; the whole report is in the thread)\n${view.finalText.slice(-RESULT_MAX)}` : view.finalText

      // Mid-turn text is not a report: say so rather than hand it over as one.
      return { result: view.isEnded ? text : `(still working, latest message so far)\n${text}` }
    }
    // A tool call is already an explicit decision, so this presses archive until it has gone through
    // (the pane asks twice; an orb the pane had already armed needs only one press).
    if ((await pressArchive(p, id)) === 'armed') await pressArchive(p, id)
    // A read that started before the archive may still list the orb and write it back when it ends:
    // wait that read out (or read, if the last one is stale), then take the orb off the list again.
    await pollNow(p, FRESH_MS)
    await p.orbs.set(orbs => orbs.filter(o => o.id !== id))

    return { result: `archived ${id}` }
  }

  if (tool === 'orb_status') {
    await pollNow(p, FRESH_MS)

    return { result: await statusText(p, { ids: list(e.ids), all: e.all === true }) }
  }

  if (tool === 'orb_wait') return wait(p, e, signal)

  return { deny: `orbit: unknown tool ${tool}` }
}
