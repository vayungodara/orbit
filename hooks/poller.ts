// The one place that reads Amp on a timer. It writes `orbs`, and the pane, tools and skyline read
// it. Module variables (timer, backoff) start over on a reload; the state itself is the host's.
// It takes a `Ports` instead of `$`: the engine follows `$` only inside the file that holds it.
import type { Orb, OrbPr } from '../types'
import { ampExport, ampList, ampUsage, ghPr } from './cli'
import { blankOrb, parseExport, parseUsage, shortTitles, sizeOfCores, STALE_MS, stateOf } from './model'
import type { Ports } from './ports'
import { EXPORT_GAP_MS, exportsDue, FAST_MS, GH_GAP_MS, listDelay, MAX_EXPORTS, QUIET_STOP_MS } from './scheduler'

const USAGE_GAP_MS = 60_000
const MAX_PR_CALLS = 8
const NOTIFY = ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run']
// The store key of the notifications sent, `{ [event]: when }`, and how long an event is kept.
const NOTIFIED = 'notified'
const NOTIFIED_MS = 86_400_000
// A thread that still cannot be read this long after its change shows as failed, with this line.
const UNREADABLE_MS = 3_600_000
const UNREADABLE = 'cannot read this thread'

let timer: ReturnType<Ports['after']> | null = null
// When the pending timer fires. Only read while `timer` is set and still in the future.
let dueAt = 0
// The ports of the session's start: every timer runs on them, whichever dispatch asked for it. A
// timer armed on a tool call's or a press's ports belongs to that dispatch, and a cancelled
// dispatch drops it. Until a session start (or a measurement, after a reload) brings them, a
// caller's own ports stand in.
let session: Ports | null = null
// The cadence last in force, for the retry when a schedule's own read fails.
let cadence = FAST_MS
let failures = 0
let wantedUntil = 0
let lastPollAt = 0
let lastGhAt = 0
let polling: Promise<void> | null = null
// When an export last failed, per orb: a failing orb is retried at most every EXPORT_GAP_MS.
const failedExports = new Map<string, number>()
// When a message was last sent to an orb from here. Until a reading taken after it lands, the orb
// is working, whatever a read that started before the send says when it lands.
const sentAt = new Map<string, number>()
let notify = true
let notifyAfterMs = 300_000
// Notifications go out one at a time, so two in one pass never write over each other's key.
let notifying: Promise<void> = Promise.resolve()

export function configure(o: { notify: boolean; notifyAfterMs: number }): void {
  notify = o.notify
  notifyAfterMs = o.notifyAfterMs
}

export async function start(p: Ports): Promise<void> {
  session = p
  // A poll that throws must not end the watch: pollNow schedules the next read whatever happened.
  await pollNow(p).catch(() => undefined)
}

/**
 * From a frequent, short hook (the session's measurement after each turn): a reload cancels the
 * plugin's timers, and if no session start follows it, this arms the next read again. Idle, it
 * arms nothing.
 */
export async function rearm(p: Ports): Promise<void> {
  session ??= p
  await schedule(p)
}

/** Forget the timer and the backoff, as a reload does. For tests, which share this module. */
export function resetPoller(): void {
  timer?.cancel()
  timer = null
  dueAt = 0
  session = null
  cadence = FAST_MS
  failures = 0
  wantedUntil = 0
  lastPollAt = 0
  lastGhAt = 0
  polling = null
  failedExports.clear()
  sentAt.clear()
  notifying = Promise.resolve()
}

export async function want(p: Ports, forMs = 600_000): Promise<void> {
  wantedUntil = Math.max(wantedUntil, (await p.now()) + forMs)
  await schedule(p)
}

export async function pollNow(p: Ports, maxAgeMs = 0): Promise<void> {
  try {
    // A read already under way is the freshest there is: wait for it rather than answer from before it.
    if (polling) return await polling
    if ((await p.now()) - lastPollAt < maxAgeMs) return
    polling ??= pollOnce(p).finally(() => {
      polling = null
    })

    return await polling
  } finally {
    // Whoever asked, the next read is scheduled: a read after the idle stop may have found work.
    await schedule(p)
  }
}

/** A read that starts after this call: one already under way may predate what the caller just did, so it is waited out first. */
export async function pollFresh(p: Ports): Promise<void> {
  if (polling) await polling.catch(() => undefined)

  return pollNow(p)
}

export async function addStarted(p: Ports, orb: Orb): Promise<void> {
  await p.orbs.set(list => [orb, ...list.filter(o => o.id !== orb.id)])
}

/** A message reached the orb: it is working from now, so waits and labels see the new turn at once. */
export async function markSent(p: Ports, id: string): Promise<void> {
  sentAt.set(id, await p.now())
  await p.orbs.set(list => list.map(afterSend))
}

// The orb as a send from here leaves it: a change at the send's time that no reading has seen yet.
function afterSend(o: Orb): Orb {
  const at = sentAt.get(o.id)
  if (at === undefined || o.exportedAt >= at) return o

  return { ...o, state: 'working', changedAt: Math.max(o.changedAt, at), isEnded: false, isListOnly: false }
}

// A toast or a notification is news only for an orb whose thread was read, or that was started
// here: an orb seen for the first time, or never read since, may have ended its turn long ago.
const isKnown = (o: Orb) => o.exportedAt > 0 || o.isStartedHere

async function schedule(p: Ports): Promise<void> {
  const host = session ?? p
  try {
    // Every await comes first. From the cancel to the assignment there is none, so overlapping calls
    // (start, want, a timer firing) can never leave a second timer behind that nothing can cancel.
    const now = await host.now()
    const delay = listDelay(now, await host.orbs.get(), wantedUntil, failures)
    if (delay !== null) cadence = delay
    // A pending timer that fires no later than this one stays: re-arming a full delay on every call
    // would starve a caller that asks more often than the cadence (the pane, an orb_wait loop).
    if (delay !== null && timer && dueAt > now && dueAt <= now + delay) return
    timer?.cancel()
    timer = null
    if (delay === null) return
    arm(host, delay, now + delay)
  } catch {
    // A read that fails must not end the chain: unless a timer is pending, try again at the cadence
    // last in force. Its due time is unknown, so the next schedule that can read replaces it.
    try {
      if (!timer) arm(host, cadence, Infinity)
    } catch {
      // No clock at all: the next pollNow, want or measurement schedules again.
    }
  }
}

function arm(host: Ports, delay: number, at: number): void {
  dueAt = at
  const own = host.after(delay, () => {
    // Only its own: a callback that comes late must not forget the timer that replaced it.
    if (timer === own) timer = null
    void pollNow(session ?? host).catch(() => undefined)
  })
  timer = own
}

function mergePrs(old: readonly OrbPr[], found: readonly OrbPr[]): OrbPr[] {
  const byUrl = new Map(old.map(pr => [pr.url, pr]))

  return found.map(pr => byUrl.get(pr.url) ?? pr)
}

async function pollOnce(p: Ports): Promise<void> {
  const now = await p.now()
  lastPollAt = now
  let rows
  try {
    rows = await ampList(p)
  } catch (error) {
    failures += 1
    const text = error instanceof Error ? error.message : String(error)
    const old = await p.error.get()
    if (old?.text !== text) await p.error.set(() => ({ text, at: now }))

    return
  }
  failures = 0
  const before = await p.orbs.get()
  const byId = new Map(before.map(o => [o.id, o]))
  const changed = new Set<string>()
  const next: Orb[] = []
  for (const row of rows) {
    if (!row.isOrb) continue
    const old = byId.get(row.id)
    if (!old && now - row.updatedAt > STALE_MS) continue
    const isChanged = !old || old.updatedAt !== row.updatedAt || old.messageCount !== row.messageCount
    if (isChanged) changed.add(row.id)
    next.push(afterSend({
      ...(old ?? blankOrb(row.id)),
      title: row.title,
      updatedAt: row.updatedAt,
      messageCount: row.messageCount,
      changedAt: !isChanged ? old!.changedAt : old ? now : row.updatedAt,
      // Quiet for over an hour when first seen: not read until it changes or is selected.
      isListOnly: old ? old.isListOnly && !isChanged : now - row.updatedAt > QUIET_STOP_MS,
    }))
  }
  for (const old of before) {
    if (old.isStartedHere && !next.some(o => o.id === old.id) && now - old.changedAt < STALE_MS) next.push(afterSend(old))
  }
  const selected = await p.selected.get()
  const isPaneOpen = await p.isPaneOpen.get()
  // A few per pass: the rest keep their unread change and are read on a later pass.
  const due = exportsDue(now, next, changed, selected, isPaneOpen).filter(id => now - (failedExports.get(id) ?? -Infinity) >= EXPORT_GAP_MS)
  for (const id of due.slice(0, MAX_EXPORTS)) {
    const i = next.findIndex(o => o.id === id)
    const orb = next[i]!
    try {
      const view = parseExport(await ampExport(p, id))
      failedExports.delete(id)
      if ((sentAt.get(id) ?? Infinity) <= now) sentAt.delete(id)
      next[i] = { ...orb, mode: view.mode ?? orb.mode, createdAt: view.createdAt || orb.createdAt, steps: view.steps, prs: mergePrs(orb.prs, view.prs), finalText: view.finalText, agentState: view.agentState, isEnded: view.isEnded, isErrored: view.isErrored, exportedAt: now, isListOnly: false }
    } catch {
      // Keep the last good reading, and wait a full gap before trying this orb again.
      failedExports.set(id, now)
      // After an hour it stops spinning: failed, and read as of now until it changes again, so the
      // reads wind down. Quietly (its turn counts as seen): orbit cannot read it, which is no news of the orb.
      if (!orb.isListOnly && now - orb.changedAt >= UNREADABLE_MS) {
        next[i] = { ...orb, isErrored: true, finalText: UNREADABLE, exportedAt: now, seenTurn: `${id}:${orb.messageCount}` }
      }
    }
  }
  for (let i = 0; i < next.length; i += 1) next[i] = { ...next[i]!, state: stateOf(next[i]!, now) }
  // Only an orb read before can end a turn: a first read (a session's staggered start-up) is no news.
  const isTurnEnd = next.some(o => {
    const old = byId.get(o.id)

    return !!old && isKnown(old) && old.state === 'working' && o.state !== 'working'
  })
  if (isPaneOpen || isTurnEnd) await refreshPrs(p, next, now, isTurnEnd)
  if (isPaneOpen && selected) await refreshUsage(p, next, selected, now)
  announce(p, before, next, now)
  // The exports and gh calls above took minutes at worst, and an orb may have been added meanwhile
  // (orb_start's addStarted): keep what appeared since `before`, and apply the same rule to whatever
  // the cell holds at write time, so a set that lands between this read and the write is not lost.
  // A message sent while this read was under way started a turn this read cannot have seen.
  const known = new Set([...before, ...next].map(o => o.id))
  const withAdded = (current: Orb[]): Orb[] => [...current.filter(o => !known.has(o.id)), ...next.map(afterSend)]
  const current = await p.orbs.get()
  if (JSON.stringify(current) !== JSON.stringify(withAdded(current))) await p.orbs.set(withAdded)
  if ((await p.error.get()) !== null) await p.error.set(() => null)
}

async function refreshPrs(p: Ports, orbs: Orb[], now: number, isForced: boolean): Promise<void> {
  if (!isForced && now - lastGhAt < GH_GAP_MS) return
  lastGhAt = now
  let calls = 0
  for (let i = 0; i < orbs.length; i += 1) {
    const orb = orbs[i]!
    if (orb.state === 'stale' || orb.prs.length === 0) continue
    const prs = [...orb.prs]
    for (let j = 0; j < prs.length && calls < MAX_PR_CALLS; j += 1) {
      if (prs[j]!.state === 'merged' || prs[j]!.state === 'closed') continue
      calls += 1
      try {
        prs[j] = { ...prs[j]!, ...(await ghPr(p, prs[j]!.url)) }
      } catch {
        // gh missing or offline: badges stay as they were.
      }
    }
    orbs[i] = { ...orb, prs }
  }
}

async function refreshUsage(p: Ports, orbs: Orb[], id: string, now: number): Promise<void> {
  const old = await p.usage.get()
  if (old?.id === id && now - old.fetchedAt < USAGE_GAP_MS) return
  try {
    const u = parseUsage(await ampUsage(p, id))
    await p.usage.set(() => ({ id, ...u, fetchedAt: now }))
    const i = orbs.findIndex(o => o.id === id)
    const size = sizeOfCores(u.cores)
    if (i >= 0 && size && !orbs[i]!.size) orbs[i] = { ...orbs[i]!, size }
  } catch {
    // Usage is optional detail.
  }
}

function announce(p: Ports, before: readonly Orb[], next: Orb[], now: number): void {
  const prev = new Map(before.map(o => [o.id, o]))
  const shorts = shortTitles(next.map(o => o.title))
  next.forEach((orb, i) => {
    const old = prev.get(orb.id)
    if (!old || !isKnown(old)) return
    const name = shorts[i] ?? orb.title
    for (const pr of orb.prs) {
      if (!old.prs.some(q => q.url === pr.url)) {
        p.toast(`◉ ${name} opened PR #${pr.number}`)
        ping(p, orb, `opened PR #${pr.number}`, `${orb.id}:${pr.url}`, now)
      }
    }
    const turn = `${orb.id}:${orb.messageCount}`
    if (old.state !== 'working' || orb.state === 'working' || orb.seenTurn === turn) return
    next[i] = { ...orb, seenTurn: turn }
    if (orb.state === 'failed') {
      p.toast(`◉ ${name} failed`)
      ping(p, orb, 'failed', turn, now)
    } else if (orb.state === 'waiting') {
      p.toast(`◉ ${name} is waiting on you`)
    } else if (orb.state === 'done') {
      p.toast(`◉ ${name} finished`)
    }
  })
}

function ping(p: Ports, orb: Orb, what: string, key: string, now: number): void {
  if (!notify || !orb.createdAt || now - orb.createdAt < notifyAfterMs) return
  const title = Array.from(orb.title.replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, 120).join('')
  notifying = notifying.then(() => notifyOnce(p, key, `${title} ${what}`, now)).catch(() => undefined)
}

// A macOS notification is system-wide, and every open session polls on its own and sees the same
// event: the store, which the sessions share, remembers each event notified (`key`, for a day), so
// it is sent once. A toast stays per session, since it shows in that session's window.
async function notifyOnce(p: Ports, key: string, text: string, now: number): Promise<void> {
  try {
    const raw = await p.store.get(NOTIFIED)
    const seen: Record<string, number> = {}
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, at] of Object.entries(raw)) if (typeof at === 'number' && now - at < NOTIFIED_MS) seen[k] = at
    }
    if (key in seen) return
    seen[key] = now
    await p.store.set(NOTIFIED, seen)
  } catch {
    // The store cannot be read or written: notify anyway, at worst once per session.
  }
  await p.run(['osascript', ...NOTIFY, '--', text, 'orbit'], { timeoutMs: 10_000 })
}
