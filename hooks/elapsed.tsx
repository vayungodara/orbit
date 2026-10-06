// Copy of skyline/hooks/elapsed.tsx, so orbit's step icons match the bar. Keep it in sync by copying again.
import type { ClientModule } from 'claude-code'

// How long the current step has run, counted on the surface's own frame clock so the hooks
// module never ticks. A quick step needs no clock, so nothing shows for the first few seconds.

const started = new WeakSet<object>()

/** "45s", "2m 10s", "1h 5m": seven characters at most, below a hundred hours. */
export function seconds(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`

  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

const Elapsed: ClientModule<{ since: number; after?: number; color?: string; width?: number }, number> = (props, surface) => {
  // The state only counts ticks to ask for a redraw; the time itself is read from the wall
  // clock, so a step that changes under the same instance counts from its own start. Written
  // as "at least `after`", a clock the surface withholds (NaN) draws nothing rather than NaN.
  if (!started.has(surface)) {
    started.add(surface)
    surface.every(1000, () => surface.setState((surface.state ?? 0) + 1))
  }
  // Until then it draws nothing and takes no columns; from then on exactly the `width` the bar
  // kept for it, so "59s" turning "1m 0s" neither moves what follows nor overflows the line.
  const ms = Date.now() - props.since
  const { Box, Text } = surface.elements

  return ms >= (props.after ?? 3000) ? (
    <Box width={props.width}>
      <Text color={props.color ?? 'inactive'}>{seconds(ms)}</Text>
    </Box>
  ) : (
    <Text>{''}</Text>
  )
}

export default Elapsed
