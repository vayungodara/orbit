import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import type { Orb, OrbitError, OrbPr, OrbUsage } from '../types'
import { resetSending } from '../hooks/actions'
import { blankOrb } from '../hooks/model'
import { markSent, resetPoller } from '../hooks/poller'
import type { Cell, Ports } from '../hooks/ports'
import { serveTool, TOOLS } from '../hooks/tools'
import { exportJson, LIST } from './fixtures'

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const NOW = Date.parse('2026-10-05T19:00:30.000Z')
const ID = 'T-0f0e0d0c-0001-7000-8000-000000000001'
const ID2 = 'T-0f0e0d0c-0002-7000-8000-000000000002'
const call = ($: Engine, tool: string, input: Record<string, unknown> = {}) => $.tool.call({ tool: `mcp__orbit__${tool}`, ...input } as never) as Promise<{ result?: string; deny?: string }>

function world(on: On) {
  const runs: { argv: string; stdin?: string }[] = []
  const registered: string[] = []
  const archived = new Set<string>()
  const checks: { tool: string; input: unknown }[] = []
  let decision: 'allow' | 'ask' | 'deny' = 'allow'
  let exports = 0
  // The engine loads its own copy of the hooks modules for each test, so no timer or send carries over.
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  // What the engine would decide for a tool the person has not allow-listed is `ask`: the test picks.
  on('tool.check', async (_$, e) => {
    checks.push({ tool: e.tool, input: e.input })

    return { decision } as never
  })
  on('session.start', async () => ({ cwd: '/tmp' }) as never)
  on('tool.register', async ($, e) => {
    registered.push((e as { name: string }).name)

    return { value: { tool: `mcp__orbit__${(e as { name: string }).name}` } } as never
  })
  on('command.register', async ($, e) => ({ value: { command: (e as { name: string }).name } }) as never)
  on('env.get', async ($, e, next) => ((e as { name: string }).name === 'HOME' ? ({ value: '/Users/test' } as never) : next(e)))
  on('fs.exists', async () => ({ value: false }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('process.run', async ($, e) => {
    const argv = e.argv.slice(1).join(' ')
    runs.push({ argv, stdin: e.init?.stdin })
    // A wait's host `sleep` moves the mocked clock on by the time it was asked for, so the poller's
    // timer falls due as in a session.
    if (e.argv[0] === 'sleep') {
      await clock.advance(Number(e.argv[1]) * 1000)

      return ok('') as never
    }
    if (argv.startsWith('-ox')) return ok(`https://ampcode.com/threads/${ID}\n`) as never
    if (argv.startsWith('threads list')) return ok(JSON.stringify(LIST.filter(r => !archived.has(r.id)).map((r, i) => (i === 0 ? { ...r, messageCount: 6 + exports } : r)))) as never
    if (argv.startsWith('threads archive')) archived.add(argv.split(' ')[2]!)
    if (argv.startsWith('threads export')) {
      exports += 1

      return ok(exports < 3 ? exportJson({ state: 'tool_use' }) : exportJson({ state: 'idle', text: 'Done: https://github.com/acme/acme-api/pull/40' })) as never
    }
    if (argv.startsWith('pr view')) return ok(JSON.stringify({ state: 'OPEN', statusCheckRollup: [] })) as never

    return ok('') as never
  })

  return { runs, registered, clock, checks, decide: (d: 'allow' | 'ask' | 'deny') => { decision = d } }
}

test('every orb tool is registered, and there is no way to stop an orb', async ($, on) => {
  const w = world(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  expect(w.registered).toEqual(expect.arrayContaining(['orb_start', 'orb_send', 'orb_status', 'orb_wait', 'orb_result', 'orb_archive']))
  expect(TOOLS.map(t => t.name)).toEqual(['orb_start', 'orb_send', 'orb_status', 'orb_wait', 'orb_result', 'orb_archive'])
})

test('orb_start defaults to ultra on a1.small and returns the thread', async ($, on) => {
  const w = world(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  // The start-up read is still under way; let it land so it cannot race the orb started below.
  await call($, 'orb_status')
  const ran = await call($, 'orb_start', { title: 't', prompt: 'p', project: 'acme/acme-api' })
  expect(ran.result).toContain(ID)
  const start = w.runs.find(r => r.argv.startsWith('-ox'))!
  expect(start.argv).toContain('--mode=ultra --orb-size=a1.small')
  expect(start.stdin).toBe('p')
  // The orb is tracked at once, under the title it was given.
  expect((await call($, 'orb_status')).result).toContain(`${ID} t · working · ultra/small`)
})

test('orb_start passes a chosen mode and size through', async ($, on) => {
  const w = world(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await call($, 'orb_start', { title: 't', prompt: 'p', project: 'acme/acme-api', mode: 'high', size: 'a1.large' })
  expect(w.runs.find(r => r.argv.startsWith('-ox'))!.argv).toContain('--mode=high --orb-size=a1.large')
})

test('orb_start refuses a missing prompt, a bad mode and a bad size', async ($, on) => {
  const w = world(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  expect((await call($, 'orb_start', { title: 't', project: 'acme/acme-api' })).deny).toContain('prompt')
  expect((await call($, 'orb_start', { title: 't', prompt: 'p', project: 'acme/acme-api', size: 'a1.huge' })).deny).toContain('size')
  expect((await call($, 'orb_start', { title: 't', prompt: 'p', project: 'acme/acme-api', mode: 'turbo' })).deny).toContain('mode')
  expect(w.runs.some(r => r.argv.startsWith('-ox'))).toBe(false)
})

test('orb_start never starts an orb on something that is not owner/name', async ($, on) => {
  const w = world(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  const ran = await call($, 'orb_start', { title: 't', prompt: 'p', project: '--help' })
  expect(`${ran.result ?? ran.deny}`).toContain('owner/name')
  expect(w.runs.some(r => r.argv.startsWith('-ox'))).toBe(false)
})

test('orb_send refuses a bad id and sends a message', async ($, on) => {
  const w = world(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  expect((await call($, 'orb_send', { id: 'T-1; rm', message: 'x' })).deny).toBeDefined()
  expect((await call($, 'orb_send', { id: ID, message: 'Fix it.' })).result).toContain('sent')
  expect(w.runs.some(r => r.argv === `threads continue ${ID} --orb-execute --execute=Fix it.`)).toBe(true)
})

test('orb_wait returns when the orb opens a PR', async ($, on) => {
  world(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  // Neither orb has a PR at first. A changed orb is read again at most every five minutes, so the
  // third export (the one with the PR) comes after about 300 mocked seconds of 20 second sleeps.
  const ran = await call($, 'orb_wait', { ids: [ID], until: 'pr', timeoutMinutes: 10 })
  expect(ran.result).toContain('pull/40')
  expect(ran.result).not.toContain('timed out')
})

test('orb_wait times out with the current status', async ($, on) => {
  world(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  const ran = await call($, 'orb_wait', { ids: [ID2], until: 'pr', timeoutMinutes: 1 })
  expect(ran.result).toContain('timed out')
  expect(ran.result).toContain(ID2)
})

test('orb_result returns the last message', async ($, on) => {
  world(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  // Let the start-up read (two exports) land, so the result's own export is the third.
  await call($, 'orb_status')
  expect((await call($, 'orb_result', { id: ID })).result).toContain('Done:')
})

test('orb_archive archives the orb and the list no longer shows it', async ($, on) => {
  const w = world(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  expect((await call($, 'orb_archive', { id: 'nope' })).deny).toBeDefined()
  expect((await call($, 'orb_archive', { id: ID })).result).toContain('archived')
  expect(w.runs.filter(r => r.argv === `threads archive ${ID}`).length).toBe(1)
  expect((await call($, 'orb_status')).result).not.toContain(ID)
})

test('with the engine saying ask, the tools that change something do not run, and the read-only ones do', async ($, on) => {
  const w = world(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  w.decide('ask')
  const started = await call($, 'orb_start', { title: 't', prompt: 'p', project: 'acme/acme-api' })
  expect(started.deny).toBe('orbit: orb_start needs permission. Add mcp__orbit__orb_start (or mcp__orbit__*) to your allow rules.')
  expect((await call($, 'orb_send', { id: ID, message: 'Fix it.' })).deny).toContain('mcp__orbit__orb_send')
  expect((await call($, 'orb_archive', { id: ID })).deny).toContain('mcp__orbit__orb_archive')
  expect(w.runs.some(r => r.argv.startsWith('-ox') || r.argv.startsWith('threads continue') || r.argv.startsWith('threads archive'))).toBe(false)
  expect((await call($, 'orb_status')).result!.split('\n')).toHaveLength(2)
  // The engine was asked about the tool and its arguments, never the call's envelope.
  expect(w.checks.find(c => c.tool === 'mcp__orbit__orb_start')?.input).toEqual({ title: 't', prompt: 'p', project: 'acme/acme-api' })
  w.decide('allow')
  expect((await call($, 'orb_send', { id: ID, message: 'Fix it.' })).result).toContain('sent')
})

test('a five minute wait costs about one list read every 30 seconds, not one every sleep step', async ($, on) => {
  const w = world(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  // ID2 never opens a PR, so this runs its whole five minutes.
  const ran = await call($, 'orb_wait', { ids: [ID2], until: 'pr', timeoutMinutes: 5 })
  expect(ran.result).toContain('timed out after 5 min')
  const lists = w.runs.filter(r => r.argv.startsWith('threads list')).length
  const sleeps = w.runs.filter(r => r.argv === '5').length
  // The start-up read plus one per 30 seconds; the wait itself reads nothing.
  expect(lists).toBeLessThanOrEqual((5 * 60) / 30 + 1)
  expect(lists).toBeGreaterThanOrEqual(5)
  expect(sleeps).toBeGreaterThanOrEqual(55)
})

// The tools below take a `Ports`, so these tests hand them a hand-made one: no engine, and control
// over the abort signal, the permission check and what Amp answers while a read is under way.

function cell<T>(value: T): Cell<T> & { value: T } {
  const c = {
    value,
    get: async () => c.value,
    set: async (change: (v: T) => T) => (c.value = change(c.value)),
  }

  return c
}

const done = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false })

// Each `sleep` moves the clock on by the time it was asked for, or by `sleepMs(seconds, n)` (the clock
// never moves by itself); `sleepGate` holds a sleep until it resolves; `exportFor` is what Amp says an
// orb's thread export holds (by default every orb is mid-turn); `listFails` makes `amp threads list` fail.
type Lab = {
  check?: Ports['checkTool']
  orbs?: Orb[]
  sleepMs?: (seconds: number, n: number) => number
  sleepGate?: Promise<void>
  exportFor?: (id: string) => string
  listFails?: string
  onSleep?: (n: number, p: Ports) => Promise<void>
}

function lab(o: Lab = {}) {
  resetPoller()
  resetSending()
  const runs: string[] = []
  const sleeps: string[] = []
  const delays: number[] = []
  const archived = new Set<string>()
  let elapsed = 0
  let gate: Promise<void> | null = null
  let release = () => {}
  const orbs = cell<Orb[]>(o.orbs ?? [blankOrb(ID), blankOrb(ID2)])
  const armed = cell<string | null>(null)
  const selected = cell<string | null>(null)
  const ports: Ports = {
    run: async argv => {
      const line = argv.slice(1).join(' ')
      runs.push(line)
      if (argv[0] === 'sleep') {
        sleeps.push(argv[1]!)
        await o.sleepGate
        await o.onSleep?.(sleeps.length, ports)
        elapsed += (o.sleepMs ?? ((seconds: number) => seconds * 1000))(Number(argv[1]), sleeps.length)

        return done('')
      }
      if (line.startsWith('threads list')) {
        if (o.listFails) return { exitCode: 1, stdout: '', stderr: o.listFails, isStdoutTruncated: false }
        // What this read sees is fixed before the gate: a slow amp answers with the world as it was.
        const body = JSON.stringify(LIST.filter(r => !archived.has(r.id)))
        if (gate) await gate

        return done(body)
      }
      if (line.startsWith('threads archive')) {
        archived.add(line.split(' ')[2]!)
        // The slow read finishes just after the archive has been answered.
        if (gate) setTimeout(release, 0)

        return done('')
      }
      if (line.startsWith('threads export')) return done((o.exportFor ?? (() => exportJson({ state: 'tool_use' })))(argv[argv.length - 1]!))

      return done('')
    },
    home: async () => '/Users/test',
    exists: async () => false,
    now: async () => NOW + elapsed,
    after: ms => {
      delays.push(ms)

      return { cancel: () => undefined }
    },
    toast: () => undefined,
    openPane: async () => undefined,
    checkTool: o.check ?? (async () => ({ decision: 'allow' })),
    store: { get: async () => undefined, set: async () => undefined },
    orbs,
    selected,
    usage: cell<OrbUsage | null>(null),
    error: cell<OrbitError | null>(null),
    armed,
    isPaneOpen: cell(false),
  }

  return {
    ports, runs, sleeps, delays, orbs, armed,
    lists: () => runs.filter(r => r.startsWith('threads list')).length,
    hold: () => {
      gate = new Promise<void>(resolve => {
        release = resolve
      })
    },
  }
}

const serve = (w: ReturnType<typeof lab>, tool: string, input: Record<string, unknown> = {}, signal = new AbortController().signal) =>
  serveTool(w.ports, { tool: `mcp__orbit__${tool}`, ...input }, signal) as Promise<{ result?: string; deny?: string }>

const START = { title: 't', prompt: 'p', project: 'acme/acme-api' }
const INPUTS: Record<string, Record<string, unknown>> = { orb_start: START, orb_send: { id: ID, message: 'Fix it.' }, orb_archive: { id: ID } }
const throws = async (): Promise<never> => {
  throw new Error('no verdict')
}

test('a tool the permission settings deny runs nothing', async () => {
  for (const tool of ['orb_start', 'orb_send', 'orb_archive', 'orb_status']) {
    const w = lab({ check: async () => ({ decision: 'deny', reason: `${tool} is blocked` }) })
    expect(await serve(w, tool, INPUTS[tool] ?? {})).toEqual({ deny: `orbit: ${tool} is blocked` })
    expect(w.runs).toEqual([])
  }
})

test('the permission check sees the tool and its arguments, not the call envelope', async () => {
  const seen: { tool: string; input: Record<string, unknown> }[] = []
  const w = lab({
    check: async (tool, input) => {
      seen.push({ tool, input })

      return { decision: 'allow' }
    },
  })
  await serve(w, 'orb_send', { id: ID, message: 'Fix it.', tool_use_id: 'toolu_1' })
  expect(seen).toEqual([{ tool: 'mcp__orbit__orb_send', input: { id: ID, message: 'Fix it.' } }])
})

test('the tools that change something run only on an explicit allow: ask is a deny that names the rule', async () => {
  for (const tool of ['orb_start', 'orb_send', 'orb_archive']) {
    const w = lab({ check: async () => ({ decision: 'ask' }) })
    const ran = await serve(w, tool, INPUTS[tool]!)
    expect(ran).toEqual({ deny: `orbit: ${tool} needs permission. Add mcp__orbit__${tool} (or mcp__orbit__*) to your allow rules.` })
    expect(w.runs).toEqual([])
  }
})

test('a permission check that fails is a deny for the tools that change something', async () => {
  for (const tool of ['orb_start', 'orb_send', 'orb_archive']) {
    const w = lab({ check: throws })
    const ran = await serve(w, tool, INPUTS[tool]!)
    expect(ran).toEqual({ deny: expect.stringContaining(`orbit: ${tool} was not run, its permission check failed (no verdict). Add mcp__orbit__${tool} (or mcp__orbit__*) to your allow rules.`) })
    expect(w.runs).toEqual([])
  }
})

test('the read-only tools stop only on an explicit deny: ask and a failed check still run them', async () => {
  for (const check of [async () => ({ decision: 'ask' as const }), throws]) {
    const w = lab({ check })
    expect((await serve(w, 'orb_status')).result!.split('\n')).toHaveLength(2)
    expect((await serve(w, 'orb_result', { id: ID })).result).toBe('(no final message yet)')
    expect((await serve(w, 'orb_wait', { ids: [ID], until: 'any', timeoutMinutes: 1 })).result).toBeDefined()
  }
})

test('orb_send does not send a second message while one is under way', async () => {
  const w = lab()
  let finish = () => {}
  const slow = new Promise<void>(resolve => {
    finish = resolve
  })
  const run = w.ports.run
  w.ports.run = async (argv, init) => (argv.includes('--orb-execute') ? (await slow, run(argv, init)) : run(argv, init))
  const first = serve(w, 'orb_send', { id: ID, message: 'one' })
  const second = await serve(w, 'orb_send', { id: ID, message: 'two' })
  expect(second).toEqual({ deny: `orb_send: already sending to ${ID}` })
  finish()
  expect((await first).result).toContain('sent')
})

// The wait: the poller owns every Amp read, so a wait adds none of its own.

test('a wait only asks the poller to keep its watched cadence: no reads of its own, a 5 second sleep each step', async () => {
  const w = lab()
  const ran = await serve(w, 'orb_wait', { ids: [ID], until: 'idle', timeoutMinutes: 5 })
  expect(ran.result).toContain('timed out after 5 min')
  // The one read at the start, then the timer (which this test's ports never fire) does the reading.
  expect(w.lists()).toBe(1)
  expect(w.delays).toContain(30_000)
  expect(new Set(w.sleeps)).toEqual(new Set(['5']))
  expect(w.sleeps).toHaveLength(60)
})

test('a wait reads at the start only when the cache is older than the watched cadence', async () => {
  const w = lab()
  await serve(w, 'orb_status')
  expect(w.lists()).toBe(1)
  await serve(w, 'orb_wait', { ids: [ID], until: 'any', timeoutMinutes: 1 })
  expect(w.lists()).toBe(1)
})

test('the last step is cut to the time left before the deadline', async () => {
  // The first sleep jumps the clock to 58 seconds into a minute's wait: 2 seconds are left.
  const w = lab({ sleepMs: (seconds, n) => (n === 1 ? 58_000 : seconds * 1000) })
  const ran = await serve(w, 'orb_wait', { ids: [ID], until: 'idle', timeoutMinutes: 1 })
  expect(w.sleeps).toEqual(['5', '2'])
  expect(ran.result).toContain('timed out after 1 min')
})

test('orb_wait stops at once when the call was already cancelled', async () => {
  const w = lab()
  const stop = new AbortController()
  stop.abort()
  const ran = await serve(w, 'orb_wait', { ids: [ID], until: 'idle' }, stop.signal)
  expect(ran.result).toContain('stopped waiting')
  expect(w.runs).toEqual([])
})

const started = async (w: ReturnType<typeof lab>) => {
  while (w.sleeps.length === 0) await new Promise(resolve => setTimeout(resolve, 0))
}

test('a cancel during a sleep ends the wait at once, without waiting for the sleep and without another read', async () => {
  let finish = () => {}
  const w = lab({ sleepGate: new Promise<void>(resolve => (finish = resolve)) })
  const stop = new AbortController()
  const wait = serve(w, 'orb_wait', { ids: [ID], until: 'idle', timeoutMinutes: 5 }, stop.signal)
  await started(w)
  const lists = w.lists()
  stop.abort()
  // The sleep is still pending (its gate is closed) and the wait is over.
  expect((await wait).result).toContain('stopped waiting')
  expect(w.lists()).toBe(lists)
  expect(w.sleeps).toHaveLength(1)
  finish()
})

test('a signal that cannot be listened to is still checked right before and right after each sleep', async () => {
  let finish = () => {}
  const w = lab({ sleepGate: new Promise<void>(resolve => (finish = resolve)) })
  const signal = { aborted: false } as AbortSignal
  const wait = serve(w, 'orb_wait', { ids: [ID], until: 'idle', timeoutMinutes: 5 }, signal)
  await started(w)
  const lists = w.lists()
  // The cancel lands while the sleep is pending; the wait notices it when the sleep returns, before any read.
  ;(signal as { aborted: boolean }).aborted = true
  finish()
  expect((await wait).result).toContain('stopped waiting')
  expect(w.lists()).toBe(lists)
  expect(w.sleeps).toHaveLength(1)
})

test('a cancel that lands during the start-up read ends the wait before its first sleep', async () => {
  const w = lab()
  const stop = new AbortController()
  const run = w.ports.run
  w.ports.run = async (argv, init) => {
    if (argv.includes('list')) stop.abort()

    return run(argv, init)
  }
  const ran = await serve(w, 'orb_wait', { ids: [ID], until: 'idle', timeoutMinutes: 5 }, stop.signal)
  expect(ran.result).toContain('stopped waiting')
  expect(w.sleeps).toEqual([])
})

test('a cancel that lands in a step, after its checks and before its sleep, ends the wait without sleeping', async () => {
  const w = lab()
  const stop = new AbortController()
  let writes = 0
  const set = w.ports.orbs.set
  const get = w.ports.error.get
  w.ports.orbs.set = change => {
    writes += 1

    return set(change)
  }
  // The start-up read writes the list once; the step writes it back unchanged (the second write) and then
  // looks at `error`, which is where the cancel arrives: past the loop's first check, before the sleep.
  w.ports.error.get = async () => {
    if (writes >= 2) stop.abort()

    return get()
  }
  const ran = await serve(w, 'orb_wait', { ids: [ID], until: 'idle', timeoutMinutes: 5 }, stop.signal)
  expect(ran.result).toContain('stopped waiting')
  expect(w.sleeps).toEqual([])
})

test('orb_wait: idle needs every orb to have ended its turn, any needs one', async () => {
  // ID has finished; ID2 keeps working.
  const exportFor = (id: string) => (id === ID ? exportJson({ state: 'idle', text: 'All done.' }) : exportJson({ state: 'tool_use' }))
  const one = await serve(lab({ exportFor }), 'orb_wait', { ids: [ID], until: 'idle' })
  expect(one.result).toStartWith(`${ID} Wave 1B cooldowns · done`)
  const any = await serve(lab({ exportFor }), 'orb_wait', { ids: [ID, ID2], until: 'any' })
  expect(any.result!.split('\n')).toHaveLength(2)
  const both = await serve(lab({ exportFor }), 'orb_wait', { ids: [ID, ID2], until: 'idle', timeoutMinutes: 1 })
  expect(both.result).toContain('timed out after 1 min')
})

test('orb_wait asks for thread ids and a known condition', async () => {
  const w = lab()
  expect((await serve(w, 'orb_wait', { ids: ['T-1; rm'] })).deny).toContain('ids')
  expect((await serve(w, 'orb_wait', { ids: [ID, 'T-1; rm'] })).deny).toContain('ids')
  expect((await serve(w, 'orb_wait', { ids: [ID], until: 'done' })).deny).toContain('until')
  expect(w.runs).toEqual([])
})

test('orb_wait caps the timeout at 120 minutes', async () => {
  // Each sleep moves the clock on by 61 minutes, so a cap that held ends the wait on the second.
  const w = lab({ sleepMs: () => 61 * 60_000 })
  const ran = await serve(w, 'orb_wait', { ids: [ID], until: 'idle', timeoutMinutes: 9999 })
  expect(ran.result).toContain('timed out after 120 min')
  expect(w.sleeps).toEqual(['5', '5'])
})

test('orb_wait stops with the status when it cannot sleep, instead of spinning', async () => {
  const w = lab()
  const run = w.ports.run
  w.ports.run = async (argv, init) => (argv[0] === 'sleep' ? { exitCode: 1, stdout: '', stderr: 'sleep: not found', isStdoutTruncated: false } : run(argv, init))
  const ran = await serve(w, 'orb_wait', { ids: [ID], until: 'idle', timeoutMinutes: 5 })
  expect(ran.result).toContain('stopped waiting: sleep exited 1')
})

test('orb_wait returns early, and says why, when Amp cannot be read', async () => {
  const w = lab({ listFails: 'Error: not logged in' })
  const ran = await serve(w, 'orb_wait', { ids: [ID], until: 'idle', timeoutMinutes: 30 })
  expect(ran.result!.split('\n').slice(0, 2)).toEqual(['stopped waiting: Amp could not be read.', 'amp failing: Error: not logged in'])
  // The error is said once.
  expect(ran.result!.split('Error: not logged in')).toHaveLength(2)
  expect(w.sleeps).toEqual([])
})

test('orb_wait returns early, and says which, when an id is still not tracked after a good read', async () => {
  const w = lab()
  const GONE = 'T-0f0e0d0c-0000-0000-0000-000000000000'
  const ran = await serve(w, 'orb_wait', { ids: [ID, GONE], until: 'idle', timeoutMinutes: 30 })
  expect(ran.result).toContain(`stopped waiting: ${GONE} is not tracked`)
  expect(w.sleeps).toEqual([])
  // `any` goes on while one of the ids is tracked, and gives up only when none is.
  const some = lab()
  expect((await serve(some, 'orb_wait', { ids: [ID, GONE], until: 'any', timeoutMinutes: 1 })).result).toContain('timed out')
  const none = lab()
  expect((await serve(none, 'orb_wait', { ids: [GONE], until: 'any', timeoutMinutes: 30 })).result).toContain('not tracked')
})

test('orb_result is the last message, and says when the orb is still working', async () => {
  const w = lab()
  const answer = (text: string, state: string) => async (argv: readonly string[]) => done(argv.includes('export') ? exportJson({ state, text, stop: state === 'idle' ? 'end_turn' : 'tool_use' }) : '')
  w.ports.run = answer('', 'tool_use')
  expect((await serve(w, 'orb_result', { id: ID })).result).toBe('(no final message yet)')
  w.ports.run = answer('Running the tests now.', 'tool_use')
  expect((await serve(w, 'orb_result', { id: ID })).result).toBe('(still working, latest message so far)\nRunning the tests now.')
  w.ports.run = answer('Done: all green.', 'idle')
  expect((await serve(w, 'orb_result', { id: ID })).result).toBe('Done: all green.')
})

test('orb_archive archives even when the pane had already armed the orb, and leaves nothing armed', async () => {
  const w = lab()
  w.armed.value = ID
  expect((await serve(w, 'orb_archive', { id: ID })).result).toBe(`archived ${ID}`)
  expect(w.runs.filter(r => r === `threads archive ${ID}`)).toHaveLength(1)
  expect(w.armed.value).toBeNull()
})

test('orb_archive reads Amp only when the last read is stale', async () => {
  const w = lab()
  await serve(w, 'orb_status')
  expect(w.lists()).toBe(1)
  await serve(w, 'orb_archive', { id: ID })
  expect(w.lists()).toBe(1)
})

test('an orb archived while a read was under way does not come back', async () => {
  const w = lab()
  // A read starts before the archive and answers with the list as it was (the orb still in it).
  w.hold()
  const slow = serve(w, 'orb_status')
  await new Promise(resolve => setTimeout(resolve, 0))
  expect((await serve(w, 'orb_archive', { id: ID })).result).toBe(`archived ${ID}`)
  await slow
  expect(w.orbs.value.map(o => o.id)).toEqual([ID2])
})

// An orb as Amp lists it, with its turn read and ended: a read of the list leaves it as it is.
const doneOrb = (i: number): Orb => ({ ...blankOrb(LIST[i]!.id), title: LIST[i]!.title, state: 'done', isEnded: true, agentState: 'idle', finalText: 'Done.', updatedAt: Date.parse(LIST[i]!.updated), messageCount: LIST[i]!.messageCount, changedAt: NOW - 600_000, exportedAt: NOW - 500_000 })

const pr = (n: number, over: Partial<OrbPr> = {}): OrbPr => ({ url: `https://github.com/acme/acme-api/pull/${n}`, repo: 'acme/acme-api', number: n, state: 'open', ci: 'pass', review: 'pending', ...over })
const step = (verb: string, target: string) => ({ id: `TU-${verb}`, category: 'test', verb, target, isRunning: true, isOk: true })

test('orb_status is one line per orb: id, title, state, mode and size, the current step, PRs, and how a stopped orb ended', async () => {
  const report = `${'Checked every case. '.repeat(20)}The PR is green.\n\nShould I merge it?`
  const w = lab({
    orbs: [
      { ...doneOrb(0), isEnded: false, mode: 'ultra', size: 'a1.small', steps: [step('reading', 'a.rs'), step('testing', 'cargo')], prs: [pr(28)], finalText: 'Working on it.' },
      { ...doneOrb(1), finalText: report, prs: [pr(29, { state: 'merged' }), pr(30, { ci: 'fail', review: 'none' })] },
    ],
  })
  const flat = report.replace(/\s+/g, ' ')
  expect((await serve(w, 'orb_status')).result!.split('\n')).toEqual([
    `${ID} Wave 1B cooldowns · working · ultra/small · testing cargo · PR #28 CI✓ CR…`,
    `${ID2} Wave 1D docs truth pass · waiting · PR #29 merged, #30 CI✗ CR– · "…${flat.slice(-159).trimStart()}"`,
  ])
})

test('orb_status shows the orbs that are active or changed in the last hour; ids picks orbs, and all lists every one', async () => {
  const quiet = { changedAt: NOW - 7_200_000, exportedAt: NOW - 7_100_000 }
  const w = lab({ orbs: [{ ...doneOrb(0), ...quiet }, { ...doneOrb(1), ...quiet, isErrored: true }] })
  const ids = async (input: Record<string, unknown>) => (await serve(w, 'orb_status', input)).result!.split('\n').map(line => line.split(' ')[0])
  expect(await ids({})).toEqual([ID2])
  expect(await ids({ ids: [ID] })).toEqual([ID])
  expect(await ids({ all: true })).toEqual([ID, ID2])
  const none = lab({ orbs: [{ ...doneOrb(0), ...quiet }, { ...doneOrb(1), ...quiet }] })
  expect((await serve(none, 'orb_status')).result).toBe('no orbs to show (2 tracked; all: true lists them)')
})

test('orb_status shows an unchecked PR as its number alone, and a title on one line', async () => {
  // The list read fails, so the orb stays exactly as given.
  const w = lab({ orbs: [{ ...doneOrb(0), title: 'Wave 1B:\tfix\nthe cooldowns', prs: [pr(28, { state: 'unknown', ci: 'none', review: 'none' }), pr(29)] }], listFails: 'Error: offline' })
  expect((await serve(w, 'orb_status')).result!.split('\n')[1]).toBe(`${ID} Wave 1B: fix the cooldowns · done · PR #28, #29 CI✓ CR… · "Done."`)
})

test('orb_status leads with a line when amp is failing', async () => {
  const w = lab({ orbs: [doneOrb(0)], listFails: 'Error: not logged in' })
  const lines = (await serve(w, 'orb_status')).result!.split('\n')
  expect(lines[0]).toBe('amp failing: Error: not logged in')
  expect(lines[1]!.startsWith(`${ID} `)).toBe(true)
})

test('orb_result keeps the last 3000 characters of a long report, and says so', async () => {
  const w = lab()
  const report = `${'a'.repeat(3500)} END`
  w.ports.run = async argv => done(argv.includes('export') ? exportJson({ state: 'idle', text: report }) : '')
  expect((await serve(w, 'orb_result', { id: ID })).result).toBe(`(the last 3000 characters; the whole report is in the thread)\n${report.slice(-3000)}`)
  w.ports.run = async argv => done(argv.includes('export') ? exportJson({ state: 'idle', text: 'Short.' }) : '')
  expect((await serve(w, 'orb_result', { id: ID })).result).toBe('Short.')
})

test('orb_wait any returns when an orb that started working during the wait ends its turn', async () => {
  const w = lab({
    orbs: [doneOrb(0), doneOrb(1)],
    // Both orbs were done when the wait began. A message sent from the pane starts a turn on ID
    // after the first step, and the poller reads that turn's end after the third.
    onSleep: async (n, p) => {
      if (n === 1) await markSent(p, ID)
      if (n === 3) await p.orbs.set(list => list.map(o => (o.id === ID ? { ...o, state: 'done', isEnded: true, exportedAt: NOW + 15_000 } : o)))
    },
  })
  const ran = await serve(w, 'orb_wait', { ids: [ID, ID2], until: 'any', timeoutMinutes: 1 })
  expect(ran.result).not.toContain('timed out')
  expect(w.sleeps).toHaveLength(3)
})

test('orb_start whose amp times out answers that the orb may have started, so it is not started twice', async () => {
  const w = lab()
  const run = w.ports.run
  w.ports.run = async (argv, init) => (argv.includes('-ox') ? Promise.reject(new Error('timed out after 120000ms')) : run(argv, init))
  const ran = await serve(w, 'orb_start', START)
  expect(ran.deny).toBeUndefined()
  expect(ran.result).toContain('the orb may have started; check orb_status before retrying')
  expect(ran.result).toContain('timed out after 120000ms')
})

test('orb_start whose amp prints no thread URL passes on what it printed that looks like one', async () => {
  const w = lab()
  const run = w.ports.run
  w.ports.run = async (argv, init) => (argv.includes('-ox') ? done('Booting https://ampcode.com/threads/T-oops') : run(argv, init))
  const ran = await serve(w, 'orb_start', START)
  expect(ran.result).toContain('the orb may have started; check orb_status before retrying')
  expect(ran.result).toContain('https://ampcode.com/threads/T-oops')
})
