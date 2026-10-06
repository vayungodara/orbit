import { expect, test } from 'claude-code/testing'

import { blankOrb } from '../hooks/model'
import { exportsDue, FAST_MS, listDelay, SLOW_MS, WATCH_MS } from '../hooks/scheduler'
import type { Orb } from '../types'

const NOW = 1_800_000_000_000
const orb = (id: string, over: Partial<Orb>): Orb => ({ ...blankOrb(id), ...over })

test('nothing tracked and nothing wanted means no polling at all', async () => {
  expect(listDelay(NOW, [], 0, 0)).toBe(null)
})

test('a working orb or a recent change polls every minute', async () => {
  expect(listDelay(NOW, [orb('T-00000001', { state: 'working', changedAt: NOW - 3_000_000 })], 0, 0)).toBe(FAST_MS)
  expect(listDelay(NOW, [orb('T-00000001', { state: 'done', changedAt: NOW - 60_000 })], 0, 0)).toBe(FAST_MS)
})

test('an orb that went quiet slows to five minutes, then stops after an hour', async () => {
  expect(listDelay(NOW, [orb('T-00000001', { state: 'done', changedAt: NOW - 20 * 60_000 })], 0, 0)).toBe(SLOW_MS)
  expect(listDelay(NOW, [orb('T-00000001', { state: 'done', changedAt: NOW - 2 * 3_600_000 })], 0, 0)).toBe(null)
})

test('a request to watch reads every 30 seconds, even with a working orb', async () => {
  expect(listDelay(NOW, [], NOW + 60_000, 0)).toBe(WATCH_MS)
  expect(listDelay(NOW, [orb('T-00000001', { state: 'working', changedAt: NOW })], NOW + 60_000, 0)).toBe(WATCH_MS)
})

test('failures back off by doubling, up to five minutes, but never start polling when idle', async () => {
  const busy = [orb('T-00000001', { state: 'working', changedAt: NOW })]
  expect([1, 2, 3, 9].map(f => listDelay(NOW, busy, 0, f))).toEqual([60_000, 120_000, 240_000, SLOW_MS])
  expect(listDelay(NOW, [], 0, 3)).toBe(null)
  expect(listDelay(NOW, [], NOW + 60_000, 1)).toBe(60_000)
})

test('exports: changed orbs at most every five minutes, every 30 seconds for the selected orb in an open pane', async () => {
  const a = orb('T-0000000a', { state: 'working', changedAt: NOW, exportedAt: NOW - 30_000 })
  const b = orb('T-0000000b', { state: 'working', changedAt: NOW, exportedAt: NOW - 301_000 })
  expect(exportsDue(NOW, [a, b], new Set(['T-0000000a', 'T-0000000b']), null, false)).toEqual(['T-0000000b'])
  expect(exportsDue(NOW, [a, b], new Set(['T-0000000a', 'T-0000000b']), 'T-0000000a', true)).toEqual(['T-0000000a', 'T-0000000b'])
})

test('exports: a working orb that went quiet is read once to confirm its turn ended, whatever the gap', async () => {
  const quiet = orb('T-0000000c', { state: 'working', changedAt: NOW - 100_000, exportedAt: NOW - 120_000 })
  expect(exportsDue(NOW, [quiet], new Set(), null, false)).toEqual(['T-0000000c'])
  const confirmed = { ...quiet, exportedAt: NOW - 5_000 }
  expect(exportsDue(NOW, [confirmed], new Set(), null, false)).toEqual([])
})

test('exports: the selected orb first, then the newest change first', async () => {
  const older = orb('T-0000000d', { state: 'working', changedAt: NOW - 50_000, exportedAt: 0 })
  const newer = orb('T-0000000e', { state: 'working', changedAt: NOW - 10_000, exportedAt: 0 })
  const picked = orb('T-0000000f', { state: 'working', changedAt: NOW - 30_000, exportedAt: 0 })
  expect(exportsDue(NOW, [older, newer, picked], new Set(), null, false)).toEqual(['T-0000000e', 'T-0000000f', 'T-0000000d'])
  expect(exportsDue(NOW, [older, newer, picked], new Set(), 'T-0000000f', true)).toEqual(['T-0000000f', 'T-0000000e', 'T-0000000d'])
})

test('exports: a change left unread by an earlier pass is still due, quiet or not', async () => {
  const deferred = orb('T-00000011', { state: 'working', changedAt: NOW - 30_000, exportedAt: 0 })
  expect(exportsDue(NOW, [deferred], new Set(), null, false)).toEqual(['T-00000011'])
})

test('exports: an orb known from the list alone is read only once it is selected', async () => {
  const quiet = orb('T-00000010', { state: 'done', isListOnly: true, changedAt: NOW - 7_200_000, exportedAt: 0 })
  expect(exportsDue(NOW, [quiet], new Set(), null, false)).toEqual([])
  expect(exportsDue(NOW, [quiet], new Set(), 'T-00000010', true)).toEqual(['T-00000010'])
})
