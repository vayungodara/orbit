import { expect, test } from 'claude-code/testing'

import type { Orb, OrbitError, OrbUsage } from '../types'
import { blankOrb } from '../hooks/model'
import { addStarted, markSent, pollNow, rearm, resetPoller, start, want } from '../hooks/poller'
import { MAX_EXPORTS } from '../hooks/scheduler'
import type { Cell, Ports } from '../hooks/ports'
import { asked, exportJson, LIST } from './fixtures'

// The poller takes a `Ports`, so these tests hand it a hand-made one with a clock they move
// themselves: no engine, and a way to count the timers that are live and the amp reads made.

const NOW = Date.parse('2026-10-05T19:00:30.000Z')
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false })
const WORKING = exportJson({ state: 'tool_use', tools: [{ id: 'TU-1', name: 'shell_command', input: { command: 'cargo test' } }] })

function cell<T>(value: T): Cell<T> & { value: T } {
  const c = {
    value,
    get: async () => c.value,
    set: async (change: (v: T) => T) => (c.value = change(c.value)),
  }

  return c
}

// `by` says whose ports armed the timer: the session's (`session`) or another dispatch's (`other`).
type Timer = { at: number; fn: () => void; isLive: boolean; by: string }

// `list` is what `amp threads list` answers; `exportOf` what a thread's export holds, or an Error
// for an export that fails.
// `store` is the plugin's store, which every session of the user shares.
type Options = { orbs?: Orb[]; onExport?: (p: Ports) => Promise<void>; list?: () => unknown[]; exportOf?: (id: string) => string | Error; store?: Map<string, unknown> }

function lab(o: Options = {}) {
  let t = NOW
  const timers: Timer[] = []
  const runs: string[] = []
  const toasts: string[] = []
  const orbs = cell<Orb[]>(o.orbs ?? [])
  const store = o.store ?? new Map<string, unknown>()
  const isPaneOpen = cell(false)
  const selected = cell<string | null>(null)
  // Failures a test asks for: the next read of the pane flag throws; with `getAfterSet`, the first
  // read of the orbs after the next write throws.
  const boom = { isPaneOpen: false, beforeOrbsSet: null as null | (() => void), getAfterSet: false, throwNextGet: false }
  const ports: Ports = {
    run: async (argv) => {
      const line = argv.slice(1).join(' ')
      runs.push(line)
      if (line.startsWith('threads list')) return ok(JSON.stringify(o.list ? o.list() : LIST))
      if (line.startsWith('threads export')) {
        await o.onExport?.(ports)
        const answer = o.exportOf ? o.exportOf(argv[argv.length - 1]!) : WORKING
        if (answer instanceof Error) return { exitCode: 1, stdout: '', stderr: answer.message, isStdoutTruncated: false }

        return ok(answer)
      }

      return ok('')
    },
    home: async () => '/Users/test',
    exists: async () => false,
    now: async () => t,
    after: (ms, fn) => {
      const timer = { at: t + ms, fn, isLive: true, by: 'session' }
      timers.push(timer)

      return { cancel: () => { timer.isLive = false } }
    },
    toast: text => {
      toasts.push(text)
    },
    openPane: async () => undefined,
    checkTool: async () => ({ decision: 'allow' }),
    store: {
      get: async key => store.get(key),
      set: async (key, value) => {
        store.set(key, JSON.parse(JSON.stringify(value)))
      },
    },
    orbs: {
      get: async () => {
        if (boom.throwNextGet) {
          boom.throwNextGet = false
          throw new Error('orbs read failed')
        }

        return orbs.get()
      },
      set: async change => {
        // A write that lands between the poller's read and its own write.
        const race = boom.beforeOrbsSet
        boom.beforeOrbsSet = null
        race?.()
        if (boom.getAfterSet) {
          boom.getAfterSet = false
          boom.throwNextGet = true
        }

        return orbs.set(change)
      },
    },
    selected,
    usage: cell<OrbUsage | null>(null),
    error: cell<OrbitError | null>(null),
    armed: cell<string | null>(null),
    isPaneOpen: {
      get: async () => {
        if (boom.isPaneOpen) {
          boom.isPaneOpen = false
          throw new Error('pane read failed')
        }

        return isPaneOpen.value
      },
      set: change => isPaneOpen.set(change),
    },
  }
  const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))
  const advance = async (ms: number) => {
    const until = t + ms
    for (;;) {
      await settle()
      const due = timers.filter(x => x.isLive && x.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      t = due.at
      due.isLive = false
      due.fn()
    }
    t = until
    await settle()
  }
  const lists = () => runs.filter(r => r.startsWith('threads list')).length
  const exports = () => runs.filter(r => r.startsWith('threads export'))
  const live = () => timers.filter(x => x.isLive).length

  // A timer the host lost without firing it: it is neither live nor ever called.
  const drop = () => { for (const x of timers) x.isLive = false }
  // A callback the host delivers late, after the timer was cancelled and replaced.
  const fireCancelled = () => timers.find(x => !x.isLive)?.fn()
  const orb = (id: string) => orbs.value.find(x => x.id === id)
  // The same world as another dispatch (a tool call, a press) sees it: its own reads of Amp and its own timers.
  const otherRuns: string[] = []
  const other = (): Ports => ({
    ...ports,
    run: async (argv, init) => {
      otherRuns.push(argv.slice(1).join(' '))

      return ports.run(argv, init)
    },
    after: (ms, fn) => {
      const timer = { at: t + ms, fn, isLive: true, by: 'other' }
      timers.push(timer)

      return { cancel: () => { timer.isLive = false } }
    },
  })
  const armedBy = (by: string) => timers.filter(x => x.by === by).length
  // The macOS notifications sent: osascript runs, whose arguments start with its script.
  const notes = () => runs.filter(r => r.startsWith('-e '))

  return { ports, orbs, selected, boom, toasts, runs, notes, store, otherRuns, other, armedBy, advance, lists, exports, live, drop, fireCancelled, orb, tick: (ms: number) => { t += ms } }
}

async function run(body: () => Promise<void>) {
  resetPoller()
  try {
    await body()
  } finally {
    resetPoller()
  }
}

test('overlapping start and want calls leave one live timer, and one more read when it fires', () =>
  run(async () => {
    const w = lab()
    await Promise.all([start(w.ports), start(w.ports), want(w.ports)])
    expect(w.lists()).toBe(1)
    expect(w.live()).toBe(1)
    // want() asks for the 30 s cadence: past it, exactly one more read.
    await w.advance(31_000)
    expect(w.lists()).toBe(2)
    expect(w.live()).toBe(1)
  }))

test('want called more often than the cadence does not starve the poll', () =>
  run(async () => {
    const w = lab()
    await start(w.ports)
    expect(w.lists()).toBe(1)
    for (let i = 0; i < 6; i += 1) {
      await w.advance(10_000)
      await want(w.ports)
    }
    // Re-arming 30 s from each call would have pushed the read past the minute; it fell due at 40 s.
    expect(w.lists()).toBe(2)
    expect(w.live()).toBe(1)
  }))

test('a pending timer whose time has passed without firing does not block a new one', () =>
  run(async () => {
    const w = lab()
    await start(w.ports)
    expect(w.live()).toBe(1)
    w.drop()
    w.tick(61_000)
    await want(w.ports)
    expect(w.live()).toBe(1)
  }))

test('a poll that throws does not end the watch', () =>
  run(async () => {
    const w = lab()
    await start(w.ports)
    expect(w.live()).toBe(1)
    w.boom.isPaneOpen = true
    await w.advance(60_000)
    expect(w.lists()).toBe(2)
    expect(w.live()).toBe(1)
    await w.advance(60_000)
    expect(w.lists()).toBe(3)
  }))

test('start still schedules the next read when its own poll throws', () =>
  run(async () => {
    const seeded = { ...blankOrb(LIST[0]!.id), changedAt: NOW }
    const w = lab({ orbs: [seeded] })
    w.boom.isPaneOpen = true
    await start(w.ports)
    expect(w.lists()).toBe(1)
    expect(w.live()).toBe(1)
    await w.advance(60_000)
    expect(w.lists()).toBe(2)
  }))

test('an orb added while a poll is exporting survives the poll', () =>
  run(async () => {
    const added = { ...blankOrb('T-0f0e0d0c-aaaa-7777-8888-0123456789ab'), title: 'started here', isStartedHere: true, changedAt: NOW }
    const w = lab({ onExport: async p => { await addStarted(p, added) } })
    await pollNow(w.ports)
    const ids = (await w.ports.orbs.get()).map(x => x.id)
    expect(ids).toEqual([added.id, LIST[0]!.id, LIST[1]!.id])
  }))

test('a write that lands between the poll reading and writing the orbs is not lost', () =>
  run(async () => {
    const racer = { ...blankOrb('T-0f0e0d0c-bbbb-7777-8888-0123456789ab'), title: 'raced in' }
    const w = lab()
    w.boom.beforeOrbsSet = () => { w.orbs.value = [racer, ...w.orbs.value] }
    await pollNow(w.ports)
    const ids = (await w.ports.orbs.get()).map(x => x.id)
    expect(ids).toEqual([racer.id, LIST[0]!.id, LIST[1]!.id])
  }))

// Finding: an end of turn is only ever read from the thread, after the change that started it.

const row = (over: Record<string, unknown> = {}) => ({ ...LIST[0]!, updated: new Date(NOW - 15 * 60_000).toISOString(), messageCount: 4, ...over })
const A = LIST[0]!.id

test('a follow-up whose thread cannot be read stays working: no finished toast from the old reading', () =>
  run(async () => {
    let list = [row()]
    let exportOf: (id: string) => string | Error = () => exportJson({ state: 'idle', text: 'All done.' })
    const w = lab({ list: () => list, exportOf: id => exportOf(id) })
    await pollNow(w.ports)
    expect(w.orb(A)?.state).toBe('done')
    // Someone sends a follow-up; from now on every export of the thread fails.
    w.tick(10_000)
    list = [row({ messageCount: 5, updated: new Date(NOW + 10_000).toISOString() })]
    exportOf = () => new Error('Error: network down')
    await pollNow(w.ports)
    expect(w.orb(A)?.state).toBe('working')
    // Quiet for well past 90 seconds: the confirming export runs, fails, and the orb stays working.
    w.tick(100_000)
    await pollNow(w.ports)
    expect(w.exports().length).toBe(2)
    expect(w.orb(A)?.state).toBe('working')
    expect(w.toasts.filter(x => x.includes('finished'))).toEqual([])
  }))

test('the export after a follow-up (old end_turn, newer user message) reads as working', () =>
  run(async () => {
    let list = [row()]
    let thread = exportJson({ state: 'idle', text: 'Old report.' })
    const w = lab({ list: () => list, exportOf: () => thread })
    await pollNow(w.ports)
    expect(w.orb(A)?.state).toBe('done')
    // Past the export gap, so the read that sees the follow-up exports in the same pass.
    w.tick(400_000)
    list = [row({ messageCount: 5, updated: new Date(NOW + 400_000).toISOString() })]
    thread = exportJson({ state: 'idle', text: 'Old report.', extra: [asked('Do more.')] })
    await pollNow(w.ports)
    expect(w.exports().length).toBe(2)
    expect(w.orb(A)?.state).toBe('working')
    expect(w.toasts).toEqual([])
  }))

test('a follow-up to an orb whose last turn failed is working: no second failed toast or notification', () =>
  run(async () => {
    let list = [row()]
    let thread = WORKING
    const w = lab({ list: () => list, exportOf: () => thread })
    await pollNow(w.ports)
    w.tick(400_000)
    list = [row({ messageCount: 5, updated: new Date(NOW + 400_000).toISOString() })]
    thread = exportJson({ state: 'error', text: 'Failed: out of memory.', errored: true })
    await pollNow(w.ports)
    await w.advance(0)
    expect(w.orb(A)?.state).toBe('failed')
    expect(w.toasts.filter(x => x.includes('failed'))).toHaveLength(1)
    expect(w.notes()).toHaveLength(1)
    // orb_send: the message reaches the orb, and the thread now ends in it. Amp's agent state still says error.
    await markSent(w.ports, A)
    w.tick(400_000)
    list = [row({ messageCount: 6, updated: new Date(NOW + 800_000).toISOString() })]
    thread = exportJson({ state: 'error', text: 'Failed: out of memory.', errored: true, extra: [asked('Try again.')] })
    await pollNow(w.ports)
    await w.advance(0)
    expect(w.exports()).toHaveLength(3)
    expect(w.orb(A)?.state).toBe('working')
    expect(w.toasts.filter(x => x.includes('failed'))).toHaveLength(1)
    expect(w.notes()).toHaveLength(1)
  }))

test('an orb whose thread still cannot be read an hour after its change shows as failed, quietly, and the reads wind down', () =>
  run(async () => {
    let list = [row()]
    let exportOf: (id: string) => string | Error = () => WORKING
    const w = lab({ list: () => list, exportOf: id => exportOf(id) })
    await start(w.ports)
    expect(w.orb(A)?.state).toBe('working')
    // The orb moves on, and from now on every export of its thread fails.
    list = [row({ messageCount: 5, updated: new Date(NOW + 10_000).toISOString() })]
    exportOf = () => new Error('amp threads export output was cut at 4 MiB')
    await w.advance(58 * 60_000)
    expect(w.orb(A)?.state).toBe('working')
    await w.advance(10 * 60_000)
    expect(w.orb(A)).toMatchObject({ state: 'failed', finalText: 'cannot read this thread' })
    // It is orbit that cannot read the thread, which is no news about the orb: no toast, no notification.
    expect(w.toasts).toEqual([])
    expect(w.notes()).toEqual([])
    // Nothing works and the change is over an hour old: no read is scheduled.
    expect(w.live()).toBe(0)
  }))

// Finding: a session start reads at most two threads per pass, and none that went quiet long ago.

const idOf = (i: number) => `T-0f0e0d0c-0000-7000-8000-${String(i).padStart(12, '0')}`
const orbRow = (i: number, minutesAgo: number, over: Record<string, unknown> = {}) => ({ id: idOf(i), title: `orb ${i}`, updated: new Date(NOW - minutesAgo * 60_000).toISOString(), tree: 'file:///home/user/workspace/repo', messageCount: 4, ...over })

test('ten fresh orbs cost at most two exports in the first pass, newest first, and the rest follow in later passes', () =>
  run(async () => {
    // Listed oldest first, so the order of the reads is the poller's own.
    const list = Array.from({ length: 10 }, (_, i) => orbRow(i, 2 + i)).reverse()
    const w = lab({ list: () => list, exportOf: () => exportJson({ state: 'idle', text: 'All done.' }) })
    await pollNow(w.ports)
    expect(MAX_EXPORTS).toBe(2)
    expect(w.exports()).toEqual([`threads export ${idOf(0)}`, `threads export ${idOf(1)}`])
    for (let pass = 0; pass < 4; pass += 1) {
      w.tick(30_000)
      await pollNow(w.ports)
    }
    expect(new Set(w.exports()).size).toBe(10)
    expect(w.exports().length).toBe(10)
    expect(w.orbs.value.every(o => o.state === 'done')).toBe(true)
    // An orb read late was never seen working, so its end is no news.
    expect(w.toasts).toEqual([])
  }))

test('an orb first seen quiet for over an hour is shown done without a read, until it is selected', () =>
  run(async () => {
    const list = [orbRow(1, 120)]
    const w = lab({ list: () => list, exportOf: () => exportJson({ state: 'idle', text: 'Opened https://github.com/a/b/pull/3' }) })
    await pollNow(w.ports)
    w.tick(60_000)
    await pollNow(w.ports)
    expect(w.exports()).toEqual([])
    expect(w.orb(idOf(1))).toMatchObject({ state: 'done', finalText: '', isListOnly: true })
    w.selected.value = idOf(1)
    w.tick(60_000)
    await pollNow(w.ports)
    expect(w.exports()).toEqual([`threads export ${idOf(1)}`])
    expect(w.orb(idOf(1))).toMatchObject({ state: 'done', isListOnly: false, finalText: 'Opened https://github.com/a/b/pull/3' })
    // Its PR is old news: no toast, no notification.
    expect(w.toasts).toEqual([])
    expect(w.runs.filter(r => r.startsWith('-e'))).toEqual([])
  }))

test('an orb first seen quiet is read once it changes', () =>
  run(async () => {
    let list = [orbRow(1, 120)]
    const w = lab({ list: () => list, exportOf: () => exportJson({ state: 'tool_use', extra: [asked('Do more.')] }) })
    await pollNow(w.ports)
    expect(w.exports()).toEqual([])
    w.tick(60_000)
    list = [orbRow(1, 0, { messageCount: 5 })]
    await pollNow(w.ports)
    expect(w.exports()).toEqual([`threads export ${idOf(1)}`])
    expect(w.orb(idOf(1))).toMatchObject({ state: 'working', isListOnly: false })
    expect(w.toasts).toEqual([])
  }))

test('the first reads of a session are no turn ends: no gh calls with the pane closed, until a known orb ends a turn', () =>
  run(async () => {
    const list = Array.from({ length: 6 }, (_, i) => orbRow(i, 2 + i))
    let isWorking = false
    const prOf = (id: string) => `Opened https://github.com/a/b/pull/${Number(id.slice(-12)) + 1}`
    const w = lab({ list: () => list, exportOf: id => (isWorking && id === idOf(0) ? WORKING : exportJson({ state: 'idle', text: prOf(id) })) })
    const gh = () => w.runs.filter(r => r.startsWith('pr view')).length
    for (let pass = 0; pass < 4; pass += 1) {
      await pollNow(w.ports)
      w.tick(30_000)
    }
    expect(w.exports()).toHaveLength(6)
    expect(gh()).toBe(0)
    // An orb read before starts a turn and ends it: that end checks the PRs.
    w.tick(400_000)
    list[0] = orbRow(0, 0, { messageCount: 5 })
    isWorking = true
    await pollNow(w.ports)
    expect(w.orb(idOf(0))?.state).toBe('working')
    isWorking = false
    w.tick(100_000)
    await pollNow(w.ports)
    expect(w.orb(idOf(0))?.state).toBe('done')
    expect(gh()).toBeGreaterThan(0)
  }))

// Finding: the timer runs on the session's ports, outlives the dispatch that re-armed it, and nothing ends its chain.

test('a poll a tool asks for after the idle stop re-arms the timer when it finds work', () =>
  run(async () => {
    let list = [orbRow(1, 120)]
    const w = lab({ list: () => list })
    await start(w.ports)
    // Quiet for two hours: no timer.
    expect(w.live()).toBe(0)
    list = [orbRow(1, 0, { messageCount: 5 })]
    // orb_status reads the list: the orb is working again, so reads go on without anyone asking.
    await pollNow(w.ports)
    expect(w.live()).toBe(1)
    const lists = w.lists()
    await w.advance(60_000)
    expect(w.lists()).toBe(lists + 1)
  }))

test('a timer re-armed from a tool call runs on the session ports, not the tool call\'s', () =>
  run(async () => {
    const w = lab()
    await start(w.ports)
    const tool = w.other()
    // A tool asks for the 30 second cadence: the timer moves, but on the session's ports.
    await want(tool)
    expect(w.armedBy('other')).toBe(0)
    await w.advance(31_000)
    expect(w.lists()).toBe(2)
    expect(w.otherRuns).toEqual([])
  }))

test('a schedule whose own read throws still leaves a timer, and the reads go on', () =>
  run(async () => {
    const w = lab()
    // The poll's write of the orbs arms it: the next read of the orbs, the schedule's, throws.
    w.boom.getAfterSet = true
    await start(w.ports).catch(() => undefined)
    expect(w.live()).toBe(1)
    await w.advance(60_000)
    expect(w.lists()).toBe(2)
    expect(w.live()).toBe(1)
  }))

test('a timer callback that comes late does not forget the timer that replaced it', () =>
  run(async () => {
    const w = lab()
    await start(w.ports)
    // The first timer's time passes without it firing, and a new one replaces it.
    w.tick(61_000)
    await want(w.ports)
    expect(w.live()).toBe(1)
    // Then the host delivers the first one's callback after all.
    w.fireCancelled()
    await w.advance(0)
    await want(w.ports)
    expect(w.live()).toBe(1)
  }))

test('after a reload with no session start, a measurement re-arms the reads on its own ports', () =>
  run(async () => {
    const w = lab()
    await start(w.ports)
    // A reload: the module starts over and the host cancels its timers; the orbs, host state, stay.
    resetPoller()
    expect(w.live()).toBe(0)
    await rearm(w.other())
    expect(w.live()).toBe(1)
    expect(w.armedBy('other')).toBe(1)
    await w.advance(60_000)
    expect(w.otherRuns.filter(r => r.startsWith('threads list'))).toHaveLength(1)
  }))

// Finding: each open session polls on its own, and a macOS notification goes out once between them.

test('two sessions that see the same new PR send one macOS notification between them', () =>
  run(async () => {
    const store = new Map<string, unknown>()
    const sent: string[] = []
    for (let session = 0; session < 2; session += 1) {
      resetPoller()
      let list = [row()]
      let thread = WORKING
      const w = lab({ store, list: () => list, exportOf: () => thread })
      await pollNow(w.ports)
      w.tick(400_000)
      list = [row({ messageCount: 5, updated: new Date(NOW + 400_000).toISOString() })]
      thread = exportJson({ state: 'tool_use', stop: 'tool_use', text: 'Opened https://github.com/a/b/pull/3' })
      await pollNow(w.ports)
      await w.advance(0)
      // Each session still toasts in its own window.
      expect(w.toasts.filter(x => x.includes('opened PR #3'))).toHaveLength(1)
      sent.push(...w.notes())
    }
    expect(sent).toHaveLength(1)
    expect(Object.keys(store.get('notified') as object)).toEqual([`${A}:https://github.com/a/b/pull/3`])
  }))

test('notified keys older than a day are pruned, and a recent one still blocks its notification', () =>
  run(async () => {
    const pr = 'https://github.com/a/b/pull/3'
    const store = new Map<string, unknown>([['notified', { 'T-gone:old': NOW - 25 * 3_600_000, [`${A}:${pr}`]: NOW - 3_600_000 }]])
    let list = [row()]
    let thread = WORKING
    const w = lab({ store, list: () => list, exportOf: () => thread })
    await pollNow(w.ports)
    w.tick(400_000)
    list = [row({ messageCount: 5, updated: new Date(NOW + 400_000).toISOString() })]
    thread = exportJson({ state: 'tool_use', stop: 'tool_use', text: `Opened ${pr} and https://github.com/a/b/pull/4` })
    await pollNow(w.ports)
    await w.advance(0)
    expect(w.notes()).toHaveLength(1)
    expect(Object.keys(store.get('notified') as object).sort()).toEqual([`${A}:${pr}`, `${A}:https://github.com/a/b/pull/4`])
  }))
