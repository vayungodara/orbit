export type OrbState = 'working' | 'waiting' | 'done' | 'failed' | 'stale'
export type OrbSize = 'a1.small' | 'a1.medium' | 'a1.large'
export type OrbCheck = 'pass' | 'fail' | 'pending' | 'none'

export type OrbStep = { id: string; category: string; verb: string; target: string; isRunning: boolean; isOk: boolean }

export type OrbPr = { url: string; repo: string; number: number; state: 'open' | 'merged' | 'closed' | 'unknown'; ci: OrbCheck; review: OrbCheck }

export type Orb = {
  id: string
  title: string
  url: string
  size: OrbSize | null
  mode: string | null
  state: OrbState
  createdAt: number
  updatedAt: number
  changedAt: number
  messageCount: number
  steps: OrbStep[]
  prs: OrbPr[]
  finalText: string
  agentState: string
  isEnded: boolean
  isErrored: boolean
  exportedAt: number
  seenTurn: string
  isStartedHere: boolean
  // Known from the list alone: quiet for over an hour when first seen, so its thread is not read
  // (and it shows as done, without details) until it changes or is selected.
  isListOnly: boolean
}

export type OrbUsage = { id: string; cost: string; cpu: number[]; memMiB: number[]; cores: number | null; memTotalMiB: number | null; fetchedAt: number }

export type OrbitError = { text: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    orbit: {
      orbs: Orb[]
      selected: string | null
      usage: OrbUsage | null
      error: OrbitError | null
      armed: string | null
      isPaneOpen: boolean
    }
  }
}
