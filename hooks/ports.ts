// Every way orbit's modules reach the engine. The engine follows `$` only inside the file that
// holds it, so register.tsx builds these closures from literal `$.noun.event(...)` calls, and the
// other modules take a Ports instead of `$`.
import type { Orb, OrbitError, OrbUsage } from '../types'
import type { Host } from './cli'

export const PANE = 'orbit'

export type Cell<T> = { get: () => Promise<T>; set: (change: (value: T) => T) => Promise<T> }

export type Ports = Host & {
  now: () => Promise<number>
  after: (ms: number, fn: () => void) => { cancel: () => void }
  toast: (text: string) => void
  openPane: () => Promise<unknown>
  checkTool: (tool: string, input: Record<string, unknown>) => Promise<{ decision: 'allow' | 'ask' | 'deny'; reason?: string }>
  // The plugin's own store: kept on disk and shared by every session of the user.
  store: { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void> }
  orbs: Cell<Orb[]>
  selected: Cell<string | null>
  usage: Cell<OrbUsage | null>
  error: Cell<OrbitError | null>
  armed: Cell<string | null>
  isPaneOpen: Cell<boolean>
}
