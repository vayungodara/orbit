import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { exportJson, LIST } from './fixtures'

const STATUS = 'mcp__orbit__orb_status'
const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const fail = (stderr: string) => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
const NOW = Date.parse('2026-10-05T19:00:30.000Z')

type Clock = { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }
type World = { list: () => unknown; export: () => string; toasts: string[]; runs: string[]; clock: Clock }

// A clock of the test's own, for a test that needs the host to lose a timer: `drops` timers are
// never fired, as a reload cancels the plugin's timers.
function lossyClock(on: On, drops: number): Clock {
  let t = NOW
  let left = drops
  const pending: { at: number; fire: () => void }[] = []
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
  }
  on('clock.now', async () => ({ value: t }) as never)
  on('clock.after', async ($, e, next) => {
    if (left > 0) {
      left -= 1

      return new Promise<never>(() => undefined)
    }

    return new Promise(resolve => {
      const wait = { at: t + e.ms, fire: () => resolve({ value: undefined } as never) }
      pending.push(wait)
      next.signal?.addEventListener?.('abort', () => pending.splice(pending.indexOf(wait), 1))
    })
  })
  const advance = async (ms: number) => {
    const until = t + ms
    for (;;) {
      await settle()
      const due = pending.filter(x => x.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      pending.splice(pending.indexOf(due), 1)
      t = due.at
      due.fire()
    }
    t = until
    await settle()
  }

  return { advance, settle }
}

function world(on: On, w: Partial<World> & { drops?: number } = {}): World {
  // The engine loads its own copy of the hooks modules for each test, so no timer or send carries over.
  mock.store(on)
  const state: World = {
    list: w.list ?? (() => LIST),
    export: w.export ?? (() => exportJson({ state: 'tool_use', tools: [{ id: 'TU-1', name: 'shell_command', input: { command: 'cargo test' } }] })),
    toasts: [], runs: [],
    clock: w.drops === undefined ? mock.clock(on, { now: NOW }) : lossyClock(on, w.drops),
  }
  on('session.start', async () => ({ cwd: '/tmp' }) as never)
  on('session.measure', async ($, e) => ({ changed: e.changed }) as never)
  on('tool.register', async ($, e) => ({ value: { tool: `mcp__orbit__${(e as { name: string }).name}` } }) as never)
  on('command.register', async ($, e) => ({ value: { command: (e as { name: string }).name } }) as never)
  on('env.get', async ($, e, next) => ((e as { name: string }).name === 'HOME' ? ({ value: '/Users/test' } as never) : next(e)))
  on('fs.exists', async () => ({ value: false }) as never)
  on('ui.toast', async ($, e) => {
    state.toasts.push(String((e as { text: string }).text))

    return { value: undefined } as never
  })
  on('process.run', async ($, e) => {
    const argv = e.argv.slice(1).join(' ')
    state.runs.push(argv)
    if (argv.startsWith('threads list')) {
      const list = state.list()

      return (typeof list === 'string' ? fail(list) : ok(JSON.stringify(list))) as never
    }
    if (argv.startsWith('threads export')) return ok(state.export()) as never
    if (argv.startsWith('pr view')) return ok(JSON.stringify({ state: 'OPEN', statusCheckRollup: [] })) as never
    if (e.argv[0] === 'osascript') return ok('') as never

    return fail('unexpected') as never
  })

  return state
}

// orb_status's lines, after a session start or, with `isStarted`, without one.
async function status($: Engine, isStarted = false): Promise<string[]> {
  if (!isStarted) await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  const ran = await $.tool.call({ tool: STATUS } as never)

  return String((ran as { result: unknown }).result).split('\n')
}

test('orb_status lists orbs only, with their state and steps', async ($, on) => {
  world(on)
  const s = await status($)
  expect(s.map(line => line.split(' ')[0])).toEqual(['T-0f0e0d0c-0001-7000-8000-000000000001', 'T-0f0e0d0c-0002-7000-8000-000000000002'])
  expect(s[0]).toBe('T-0f0e0d0c-0001-7000-8000-000000000001 Wave 1B cooldowns · working · ultra · running tests cargo')
})

test('a finished turn toasts once', async ($, on) => {
  const w = world(on)
  await status($)
  w.list = () => LIST.map((row, i) => (i === 0 ? { ...row, updated: '2026-10-05T19:00:20.000Z', messageCount: 8 } : row))
  w.export = () => exportJson({ state: 'idle', text: 'All done.' })
  // The change is seen at once; the turn's end is confirmed by the one export after 90 quiet seconds.
  await w.clock.advance(200_000)
  await w.clock.settle()
  expect((await status($, true))[0]).toContain(' · done')
  await status($, true)
  expect(w.toasts.filter(t => t.includes('finished')).length).toBe(1)
})

test('a new PR link toasts', async ($, on) => {
  const w = world(on)
  await status($)
  w.list = () => LIST.map((row, i) => (i === 0 ? { ...row, messageCount: 9 } : row))
  w.export = () => exportJson({ state: 'tool_use', text: 'Opened https://github.com/acme/acme-api/pull/28', stop: 'tool_use' })
  await w.clock.advance(200_000)
  await w.clock.settle()
  expect(w.toasts.some(t => t.includes('opened PR #28'))).toBe(true)
})

test('a failing amp list shows one error and is not retried while nothing is tracked', async ($, on) => {
  const w = world(on, { list: () => 'Error: not logged in' })
  expect((await status($))[0]).toBe('amp failing: Error: not logged in')
  const lists = () => w.runs.filter(r => r.startsWith('threads list')).length
  const before = lists()
  await w.clock.advance(600_000)
  await w.clock.settle()
  expect(lists()).toBe(before)
})

test('an orb missing from the list is dropped', async ($, on) => {
  const w = world(on)
  await status($)
  w.list = () => LIST.slice(1)
  // Past the 15 seconds in which orb_status answers from the last read.
  await w.clock.advance(15_000)
  expect((await status($, true)).map(line => line.split(' ')[0])).toEqual(['T-0f0e0d0c-0002-7000-8000-000000000002'])
})

test('after the host dropped the timer (a reload cancels it), the next measurement of the session re-arms it', async ($, on) => {
  // The host loses the plugin's first timer: it never fires, as when a reload cancels it.
  const w = world(on, { drops: 1 })
  await status($)
  const lists = () => w.runs.filter(r => r.startsWith('threads list')).length
  const before = lists()
  await w.clock.advance(120_000)
  await w.clock.settle()
  expect(lists()).toBe(before)
  // The end of the next turn measures the session.
  await $.session.measure({ context: { window: 200_000, tokens: 1_000, percent: 0.5 }, rateLimits: [], changed: ['context'] } as never)
  await w.clock.advance(61_000)
  await w.clock.settle()
  expect(lists()).toBeGreaterThan(before)
})

test('a headless session does not start polling until a tool asks', async ($, on) => {
  const w = world(on)
  await $.session.start({ source: 'startup', cwd: '/tmp', isInteractive: false } as never)
  await w.clock.advance(120_000)
  await w.clock.settle()
  expect(w.runs.filter(r => r.startsWith('threads list')).length).toBe(0)
  await $.tool.call({ tool: STATUS } as never)
  expect(w.runs.filter(r => r.startsWith('threads list')).length).toBe(1)
})
