// When orbit reads Amp: a pure decision, so the cadence is tested without a clock.
import type { Orb } from '../types'
import { QUIET_MS } from './model'

// Each amp call costs about 0.25 s of CPU and 200 MB while it runs, so reads are rationed.
export const WATCH_MS = 30_000
export const FAST_MS = 60_000
export const SLOW_MS = 300_000
export const ACTIVE_MS = 600_000
export const QUIET_STOP_MS = 3_600_000
export const EXPORT_GAP_MS = 300_000
export const SELECTED_GAP_MS = 30_000
export const GH_GAP_MS = 60_000
// A session that starts with many recent orbs reads their threads a few per pass, not all at once.
export const MAX_EXPORTS = 2

/** Milliseconds until the next list read, or null to stop reading. */
export function listDelay(now: number, orbs: readonly Orb[], wantedUntil: number, failures: number): number | null {
  const base =
    now < wantedUntil ? WATCH_MS
    : orbs.some(o => o.state === 'working' || now - o.changedAt < ACTIVE_MS) ? FAST_MS
    : orbs.some(o => now - o.changedAt < QUIET_STOP_MS) ? SLOW_MS
    : null
  // Backoff only slows a cadence that exists: with nothing tracked or wanted, a failing amp is not retried.
  if (base === null) return null

  return failures > 0 ? Math.max(base, Math.min(WATCH_MS * 2 ** failures, SLOW_MS)) : base
}

/**
 * The orbs to export on this pass: the selected orb first, then the newest change first. The caller
 * runs them one at a time and at most MAX_EXPORTS of them; the rest stay due for a later pass.
 */
export function exportsDue(now: number, orbs: readonly Orb[], changed: ReadonlySet<string>, selected: string | null, isPaneOpen: boolean): string[] {
  return orbs
    .filter(o => {
      // Known from the list alone (quiet for over an hour when first seen): read once someone selects it.
      if (o.isListOnly) return o.id === selected
      // o.state is the previous pass's state: the caller recomputes states after choosing exports.
      // A working orb that went quiet is read once, whatever the gap: that is how a turn's end is caught.
      if (o.state === 'working' && now - o.changedAt >= QUIET_MS && o.exportedAt < o.changedAt + QUIET_MS) return true
      // A change no read has seen stays due, so one deferred by an earlier pass is read later.
      if (!changed.has(o.id) && o.exportedAt >= o.changedAt) return false
      const gap = isPaneOpen && o.id === selected ? SELECTED_GAP_MS : EXPORT_GAP_MS

      return now - o.exportedAt >= gap
    })
    .sort((a, b) => Number(b.id === selected) - Number(a.id === selected) || b.changedAt - a.changedAt)
    .map(o => o.id)
}
