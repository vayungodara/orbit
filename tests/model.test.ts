import { expect, test } from 'claude-code/testing'

import { endsWithQuestion, parseExport, parseList, parseUsage, prLinks, QUIET_MS, shortTitles, sizeOfCores, STALE_MS, stateOf } from '../hooks/model'
import { asked, exportJson, LIST, USAGE_TEXT } from './fixtures'

const NOW = Date.parse('2026-10-05T19:05:00.000Z')

test('parseList keeps threads, marks orbs by their workspace tree, and reads times', async () => {
  const rows = parseList(JSON.stringify(LIST))
  expect(rows.map(r => r.isOrb)).toEqual([true, true, false])
  expect(rows[0]!.updatedAt).toBe(Date.parse('2026-10-05T19:00:00.000Z'))
  expect(rows[2]!.messageCount).toBe(195)
})

test('parseList rejects output that is not a JSON list', async () => {
  expect(() => parseList('Not logged in')).toThrow()
  expect(() => parseList('{"a":1}')).toThrow()
})

test('parseExport reads steps, results, final text, PRs and mode', async () => {
  const view = parseExport(exportJson({
    state: 'idle', text: 'Opened https://github.com/acme/acme-api/pull/28 and it is green.',
    tools: [
      { id: 'TU-1', name: 'shell_command', input: { command: 'cargo test' }, done: true },
      { id: 'TU-2', name: 'shell_command', input: { command: 'cargo build' }, done: true, failed: true },
      { id: 'TU-3', name: 'apply_patch', input: { patch: '*** Update File: a/b.rs' } },
    ],
  }))
  expect(view.steps.map(s => [s.category, s.isRunning, s.isOk])).toEqual([['test', false, true], ['build', false, false], ['edit', true, true]])
  expect(view.finalText).toContain('it is green')
  expect(view.prs.map(p => p.number)).toEqual([28])
  expect(view.mode).toBe('ultra')
  expect(view.isEnded).toBe(true)
})

test('parseExport keeps only the last six steps', async () => {
  const tools = Array.from({ length: 9 }, (_, i) => ({ id: `TU-${i}`, name: 'finder', input: { query: `q${i}` }, done: true }))
  expect(parseExport(exportJson({ state: 'tool_use', tools })).steps.map(s => s.id)).toEqual(['TU-3', 'TU-4', 'TU-5', 'TU-6', 'TU-7', 'TU-8'])
})

test('prLinks dedupes and reads repo and number', async () => {
  const prs = prLinks('see https://github.com/a/b/pull/7 and https://github.com/a/b/pull/7 and https://github.com/c/d-e/pull/12')
  expect(prs.map(p => `${p.repo}#${p.number}`)).toEqual(['a/b#7', 'c/d-e#12'])
})

const base = { agentState: 'idle', isEnded: true, isErrored: false, finalText: 'Done.', changedAt: NOW - 5 * 60_000, exportedAt: NOW - 4 * 60_000 }

test('stateOf: running agent state is working', async () => {
  expect(stateOf({ ...base, agentState: 'tool_use', isEnded: false }, NOW)).toBe('working')
})

test('stateOf: an ended turn is done, or waiting when it ends on a question', async () => {
  expect(stateOf(base, NOW)).toBe('done')
  expect(stateOf({ ...base, finalText: 'PR is up. Should I merge it?' }, NOW)).toBe('waiting')
})

test('stateOf: a change not yet re-read stays working until a reading shows the turn ended', async () => {
  expect(stateOf({ ...base, changedAt: NOW - 10_000, exportedAt: NOW - 60_000 }, NOW)).toBe('working')
  // Past the 90 quiet seconds too: only a reading taken after the change can end the turn.
  expect(stateOf({ ...base, changedAt: NOW - QUIET_MS - 1, exportedAt: NOW - 200_000 }, NOW)).toBe('working')
  expect(stateOf({ ...base, changedAt: NOW - QUIET_MS - 1, exportedAt: NOW - QUIET_MS }, NOW)).toBe('done')
})

test('parseExport: a follow-up after an ended turn is a turn that has not ended, whatever the agent state says', async () => {
  // Amp's agent state lags: right after a follow-up it still says idle, and the last assistant row is the old end_turn.
  const view = parseExport(exportJson({ state: 'idle', text: 'Old report.', extra: [asked('Do more.')] }))
  expect(view.isEnded).toBe(false)
  expect(view.finalText).toBe('Old report.')
  expect(stateOf({ ...view, changedAt: NOW - 60_000, exportedAt: NOW }, NOW)).toBe('working')
})

test('parseExport: a fresh orb with no reply yet has not ended, with no agent state or an idle one', async () => {
  for (const meta of [{}, { lastKnownAgentState: { state: 'idle' } }]) {
    const view = parseExport(JSON.stringify({ id: 'T-0f0e0d0c-0001-7000-8000-000000000001', created: 1, meta, messages: [asked('Do the task.')] }))
    expect(view.isEnded).toBe(false)
    expect(stateOf({ ...view, changedAt: NOW - 600_000, exportedAt: NOW }, NOW)).toBe('working')
  }
})

test('parseExport: rows of other roles after the end do not reopen the turn', async () => {
  const view = parseExport(exportJson({ state: 'idle', text: 'Done.', extra: [{ role: 'info', content: [{ type: 'text', text: 'Thread shared.' }] }] }))
  expect(view.isEnded).toBe(true)
})

test('parseExport: an error counts only for the turn it ended, so a follow-up after an errored reply is working', async () => {
  const failed = exportJson({ state: 'error', text: 'Failed: out of memory.', errored: true })
  expect(parseExport(failed).isErrored).toBe(true)
  // Amp's agent state lags, so it may still say error once the follow-up is in.
  const view = parseExport(exportJson({ state: 'error', text: 'Failed: out of memory.', errored: true, extra: [asked('Try again.')] }))
  expect(view.isErrored).toBe(false)
  expect(stateOf({ ...view, changedAt: NOW - 60_000, exportedAt: NOW }, NOW)).toBe('working')
})

test('stateOf: errors are failed, and a day without change is stale', async () => {
  expect(stateOf({ ...base, isErrored: true }, NOW)).toBe('failed')
  expect(stateOf({ ...base, changedAt: NOW - STALE_MS - 1 }, NOW)).toBe('stale')
})

test('endsWithQuestion looks only at the last sentence', async () => {
  expect(endsWithQuestion('Is this right? Yes. Done.')).toBe(false)
  expect(endsWithQuestion('Done. Want me to merge? ')).toBe(true)
  expect(endsWithQuestion('**Merge now?**')).toBe(true)
})

test('shortTitles strips a shared prefix and keeps unique titles', async () => {
  expect(shortTitles(['acme-api: Wave 1B', 'acme-api: Wave 1D', 'Notes', 'solo: one'])).toEqual(['Wave 1B', 'Wave 1D', 'Notes', 'solo: one'])
})

test('sizeOfCores maps orb machines to sizes', async () => {
  expect([2, 4, 8, 3, null].map(c => sizeOfCores(c))).toEqual(['a1.small', 'a1.medium', 'a1.large', null, null])
})

test('parseUsage reads cost and the metric series', async () => {
  const u = parseUsage(USAGE_TEXT)
  expect(u.cost).toBe('$0.18')
  expect(u.cpu).toEqual([2.55, 44.89, 47.57])
  expect(u.memMiB).toEqual([236, 562, 732])
  expect(u.cores).toBe(2)
  expect(u.memTotalMiB).toBe(3931)
})

test('stateOf: an orb known from the list alone is done, though never read', async () => {
  expect(stateOf({ ...base, isEnded: false, finalText: '', isListOnly: true, changedAt: NOW - 7_200_000, exportedAt: 0 }, NOW)).toBe('done')
})
