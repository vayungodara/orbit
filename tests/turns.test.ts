import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { asked, exportJson } from './fixtures'

// One orb's thread as Amp grows it: a first turn that ended with a report, a follow-up Claude
// sends, and three minutes later the new report. Amp's agent state says idle all along, as it
// does when it lags behind the thread.

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const NOW = Date.parse('2026-10-05T19:00:30.000Z')
const ID = 'T-0f0e0d0c-0001-7000-8000-000000000001'
const TURN_MS = 180_000
const call = ($: Engine, tool: string, input: Record<string, unknown> = {}) => $.tool.call({ tool: `mcp__orbit__${tool}`, ...input } as never) as Promise<{ result?: string; deny?: string }>

function world(on: On) {
  // The engine loads its own copy of the hooks modules for each test, so no timer or send carries over.
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const runs: string[] = []
  let messageCount = 2
  let updated = NOW - 15 * 60_000
  let askedAt: number | null = null
  // The follow-up's turn ends TURN_MS after it was sent.
  const settle = () => {
    if (askedAt !== null && clock.now() - askedAt >= TURN_MS && messageCount === 3) {
      messageCount = 4
      updated = askedAt + TURN_MS
    }
  }
  on('tool.check', async () => ({ decision: 'allow' }) as never)
  on('session.start', async () => ({ cwd: '/tmp' }) as never)
  on('tool.register', async ($, e) => ({ value: { tool: `mcp__orbit__${(e as { name: string }).name}` } }) as never)
  on('command.register', async ($, e) => ({ value: { command: (e as { name: string }).name } }) as never)
  on('env.get', async ($, e, next) => ((e as { name: string }).name === 'HOME' ? ({ value: '/Users/test' } as never) : next(e)))
  on('fs.exists', async () => ({ value: false }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('process.run', async ($, e) => {
    const argv = e.argv.slice(1).join(' ')
    runs.push(argv)
    if (e.argv[0] === 'sleep') {
      await clock.advance(Number(e.argv[1]) * 1000)

      return ok('') as never
    }
    settle()
    if (argv.startsWith('threads list')) {
      return ok(JSON.stringify([{ id: ID, title: 'acme-api: Wave 1B', updated: new Date(updated).toISOString(), tree: 'file:///home/user/workspace/repo', messageCount }])) as never
    }
    if (argv.startsWith('threads continue')) {
      askedAt = clock.now()
      messageCount = 3
      updated = askedAt
    }
    if (argv.startsWith('threads export')) {
      const followUp = messageCount >= 3 ? [asked('Do more.')] : []
      const reply = messageCount >= 4 ? [{ role: 'assistant', state: { type: 'complete', stopReason: 'end_turn' }, content: [{ type: 'text', text: 'New report.' }] }] : []

      return ok(exportJson({ state: 'idle', text: 'Old report.', extra: [...followUp, ...reply] })) as never
    }

    return ok('') as never
  })

  return { runs, clock, sleeps: () => runs.filter(r => r === '5').length }
}

test('send, wait, result: the wait outlasts the old end of turn and the result is the new report', async ($, on) => {
  const w = world(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  expect((await call($, 'orb_status')).result).toBe(`${ID} acme-api: Wave 1B · done · ultra · "Old report."`)
  // Past the export gap, so the read that follows the send exports the thread in the same pass.
  await w.clock.advance(400_000)
  await w.clock.settle()
  expect((await call($, 'orb_send', { id: ID, message: 'Do more.' })).result).toContain('sent')
  // The old report is not handed over as the answer to the follow-up.
  expect((await call($, 'orb_result', { id: ID })).result).toBe('(still working, latest message so far)\nOld report.')
  const waited = await call($, 'orb_wait', { ids: [ID], until: 'idle', timeoutMinutes: 30 })
  expect(waited.result).not.toContain('timed out')
  expect(waited.result).toBe(`${ID} acme-api: Wave 1B · done · ultra · "New report."`)
  expect(w.sleeps()).toBeGreaterThan(0)
  expect((await call($, 'orb_result', { id: ID })).result).toBe('New report.')
})
