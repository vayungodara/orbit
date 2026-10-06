// Small synthetic copies of real `amp` output (shapes taken from amp 2026-10-05).
export const LIST = [
  { id: 'T-0f0e0d0c-0001-7000-8000-000000000001', title: 'acme-api: Wave 1B cooldowns', updated: '2026-10-05T19:00:00.000Z', tree: 'file:///home/user/workspace/repo', messageCount: 6 },
  { id: 'T-0f0e0d0c-0002-7000-8000-000000000002', title: 'acme-api: Wave 1D docs truth pass', updated: '2026-10-05T18:48:27.865Z', tree: 'file:///home/user/workspace/repo', messageCount: 3 },
  { id: 'T-0e0e0d0c-0003-7000-8000-000000000003', title: 'Notes', updated: '2026-10-05T18:32:46.903Z', tree: 'file:///home/me/projects', messageCount: 195 },
]

type Tool = { id: string; name: string; input: Record<string, unknown>; done?: boolean; failed?: boolean }

// `extra` rows go after everything else: a follow-up the person sent, or a row of another role.
export function exportJson(opts: { state: string; stop?: string; text?: string; tools?: Tool[]; errored?: boolean; mode?: string; created?: number; extra?: unknown[] }): string {
  const tools = opts.tools ?? []
  const messages: unknown[] = [{ role: 'user', content: [{ type: 'text', text: 'Do the task.' }] }]
  messages.push({ role: 'assistant', state: { type: 'complete', stopReason: 'tool_use' }, content: tools.map(t => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input, complete: true })) })
  messages.push({ role: 'user', content: tools.filter(t => t.done).map(t => ({ type: 'tool_result', toolUseID: t.id, run: t.failed ? { status: 'error', error: 'boom' } : { status: 'done', result: { output: 'ok' } } })) })
  if (opts.text !== undefined) {
    messages.push({ role: 'assistant', state: { type: opts.errored ? 'error' : 'complete', stopReason: opts.stop ?? 'end_turn' }, content: [{ type: 'text', text: opts.text }] })
  }
  messages.push(...(opts.extra ?? []))

  return JSON.stringify({
    v: 1, id: 'T-0f0e0d0c-0001-7000-8000-000000000001', title: 'acme-api: Wave 1B cooldowns', created: opts.created ?? 1_791_225_011_880,
    agentMode: opts.mode ?? 'ultra',
    meta: { executorType: 'sandbox', lastKnownAgentState: { state: opts.state, messageID: 'M-1', updatedAt: '2026-10-05T19:00:00.000Z' } },
    messages,
  })
}

/** A message the person sent: the start of a turn. */
export const asked = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })

export const USAGE_TEXT = `acme-api: Wave 1D docs truth pass
Cost: $0.18
Covered by your Amp Megawatt subscription

## Orb System Metrics

### Orb \`q7x2m9k4w1p8r3t6v5n0b\`

Samples: 3

| CPU | Memory | Cache | Disk |
| ---: | ---: | ---: | ---: |
| 2.55% / 2 cores | 236 MiB / 3931 MiB (6.0%) | 106 MiB | 3756 MiB / 65127 MiB (5.8%) |
| 44.89% / 2 cores | 562 MiB / 3931 MiB (14.3%) | 296 MiB | 3812 MiB / 65127 MiB (5.9%) |
| 47.57% / 2 cores | 732 MiB / 3931 MiB (18.6%) | 372 MiB | 3822 MiB / 65127 MiB (5.9%) |
`
