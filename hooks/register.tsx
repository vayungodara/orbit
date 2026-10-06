import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Orb, OrbitError, OrbUsage } from '../types'
import { boxKey, openPane, pressArchive, select, sendMessage } from './actions'
import { CATEGORIES, type CategoryId } from './activities'
import { GLYPH, iconSvg } from './icons'
import { MARK, shortTitles, tintFor } from './model'
import { configure, rearm, start } from './poller'
import { PANE, type Ports } from './ports'
import { radiusOf, RING, sparkSvg, sparkText, sphereSvg, STATE_KEY, stillSvg } from './sphere'
import { serveTool, TOOLS } from './tools'

// The engine reads state through atoms it can see declared as consts of this file, and follows `$`
// only inside this file, so every atom and every `$` call lives here and the other modules take
// the closures of `portsOf($)` instead.
const orbsAtom = atom({ plugin: 'orbit', key: 'orbs' } as const, [] as Orb[])
const selectedAtom = atom({ plugin: 'orbit', key: 'selected' } as const, null as string | null)
const usageAtom = atom({ plugin: 'orbit', key: 'usage' } as const, null as OrbUsage | null)
const errorAtom = atom({ plugin: 'orbit', key: 'error' } as const, null as OrbitError | null)
const armedAtom = atom({ plugin: 'orbit', key: 'armed' } as const, null as string | null)
const paneAtom = atom({ plugin: 'orbit', key: 'isPaneOpen' } as const, false)

function portsOf($: EngineInterface): Ports {
  return {
    run: (argv, init) => $.process.run(argv, init),
    home: () => $.env.get('HOME'),
    exists: path => $.fs.exists(path),
    now: () => $.clock.now(),
    after: (ms, fn) => $.clock.after(ms, fn),
    toast: text => $.ui.toast(text),
    openPane: () => $.ui.open({ id: PANE, title: 'orbit' }),
    checkTool: (tool, input) => $.tool.check({ tool, input } as never),
    store: { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) },
    orbs: { get: () => read($, orbsAtom), set: change => update($, orbsAtom, change) },
    selected: { get: () => read($, selectedAtom), set: change => update($, selectedAtom, change) },
    usage: { get: () => read($, usageAtom), set: change => update($, usageAtom, change) },
    error: { get: () => read($, errorAtom), set: change => update($, errorAtom, change) },
    armed: { get: () => read($, armedAtom), set: change => update($, armedAtom, change) },
    isPaneOpen: { get: () => read($, paneAtom), set: change => update($, paneAtom, change) },
  }
}

// The pane's drawing rules. The cell is one orb's column in the constellation; a title is clipped to
// it so the pane never overflows, and a message that fails is toasted rather than thrown.
const CELL = 16
const MAX_PRS = 5
const FRESH_DONE_MS = 3_600_000

const clip = (text: string, max: number) => ([...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text)
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

function lineOf(o: Orb): string {
  if (o.state === 'working') return o.steps[o.steps.length - 1]?.verb ?? 'working'
  if (o.state === 'waiting') return 'waiting on you'
  if (o.state === 'failed') return 'failed'
  const pr = o.prs[0]

  return pr ? `PR #${pr.number} · CI ${MARK[pr.ci]}` : 'done'
}

function headOf(orbs: readonly Orb[]): string {
  return (['working', 'waiting', 'done', 'failed'] as const)
    .map(state => ({ state, n: orbs.filter(o => o.state === state).length }))
    .filter(x => x.n > 0)
    .map(x => `${x.n} ${x.state}`)
    .join(' · ')
}

export const register: Register = (on, options) => {
  configure({ notify: options.notify !== false, notifyAfterMs: Math.max(0, Number(options.notifyAfter ?? 5)) * 60_000 })

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    for (const tool of TOOLS) await $.tool.register(tool)
    await $.command.register({ name: 'orbs', description: 'Show your Amp orbs (optionally: a thread id to open)', argumentHint: '[thread id]', immediate: true })
    // Headless runs (claude -p, scheduled jobs) never poll on their own: a tool call reads Amp when asked.
    if (e.isInteractive !== false) void start(portsOf($)).catch(() => undefined)

    return result
  })

  // A reload (a /config change, say) cancels the plugin's timers. The engine raises session.start
  // again for a reloaded plugin, and this is the backstop when it does not: the session is measured
  // after every turn, and that re-arms a lapsed read timer (two cheap calls, no timer when idle).
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await rearm(portsOf($)).catch(() => undefined)

    return result
  })

  on('command.run', { command: 'orbs' }, async ($, e) => {
    const id = e.args.trim()
    await openPane(portsOf($), /^T-[0-9a-f-]{8,}$/.test(id) ? id : undefined)

    return { text: 'orbit opened.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await update($, paneAtom, () => false)
      await update($, armedAtom, () => null)
    }

    return next(e)
  })

  on('tool.call', { tool: /^mcp__orbit__orb_/ }, async ($, e, next) => {
    try {
      return await serveTool(portsOf($), e as unknown as Record<string, unknown>, next.signal)
    } catch (error) {
      return { result: `orbit: ${reason(error)}` }
    }
  })

  // The matcher spells the pane's id (PANE, 'orbit') as a literal: the scan only reads a matcher it can
  // resolve inside this file, and the tests check that /orbs opens the pane under this very id.
  on('ui.render', { component: 'Pane', requestId: 'orbit' }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Link } = elements
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    const Input = 'Input' in elements ? elements.Input : undefined
    const Client = (e.surface === 'terminal' || e.surface === 'desktop') && 'Client' in elements ? elements.Client : undefined
    const now = await $.clock.now()
    const all = (await read($, orbsAtom)).filter(o => o.state !== 'stale')
    // Only what needs attention: working, waiting and failed orbs, and done ones for an hour.
    const orbs = all.filter(o => o.state !== 'done' || now - o.changedAt < FRESH_DONE_MS)
    const selectedId = await read($, selectedAtom)
    const selected = all.find(o => o.id === selectedId) ?? null
    const armed = await read($, armedAtom)
    const usage = await read($, usageAtom)
    const error = await read($, errorAtom)
    const width = Math.max(24, e.props.bodyColumns)
    const shorts = shortTitles(orbs.map(o => o.title))

    // Neither rejects: a failure is a toast. A send can run for minutes, so the Input fires it and
    // moves on (`void`); archive is quick, so its press waits for it.
    const send = (id: string, value: string) =>
      sendMessage(portsOf($), id, value, 'pane')
        .then(result => (result === 'sent' ? $.ui.toast('◉ message sent') : result === 'already sending' ? $.ui.toast('◉ still sending the last message') : undefined))
        .catch(err => $.ui.toast(`◉ ${reason(err)}`))
    const archive = (id: string) =>
      pressArchive(portsOf($), id)
        .then(result => (result === 'archived' ? $.ui.toast('◉ archived') : undefined))
        .catch(err => $.ui.toast(`◉ ${reason(err)}`))

    // Skyline's own category colours, so the pane and the bar read as one system.
    const tintOf = (category: string) => CATEGORIES[category as CategoryId]?.tint ?? 'inactive'
    const meta = selected ? [selected.mode, selected.size?.replace('a1.', '')].filter(Boolean).join(' · ') : ''
    // The verbs share one column so the targets line up; a narrow pane clips them rather than overflow.
    // A step repeated back to back (a poll, a wait) shows once, as its latest run.
    const steps = selected ? selected.steps.filter((step, i, list) => i === list.length - 1 || list[i + 1]!.verb !== step.verb || list[i + 1]!.target !== step.target) : []
    const verbWidth = Math.min(Math.max(8, Math.floor(width / 2)), Math.max(0, ...steps.map(step => [...step.verb].length)))
    const shownUsage = selected && usage?.id === selected.id ? usage : null
    const last = selected && selected.state !== 'working' ? (selected.finalText.split('\n').map(l => l.trim()).filter(Boolean).pop() ?? '') : ''
    const hasFacts = !!selected && (selected.steps.length > 0 || selected.prs.length > 0 || !!shownUsage || !!last)
    const cpuNow = shownUsage?.cpu[shownUsage.cpu.length - 1] ?? 0
    const memNow = shownUsage?.memMiB[shownUsage.memMiB.length - 1] ?? 0

    return (
      <Box flexDirection="column" gap={1} width={width}>
        <Box key="head">
          <Text dimColor>{headOf(orbs) || 'No active orbs.'}</Text>
        </Box>
        {error && <Text key="error" color="warning" wrap="truncate">{error.text}</Text>}
        {orbs.length > 0 && (
          <Box key="sky" flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={1}>
            {orbs.map((o, i) => {
              const px = (radiusOf(o.size) + 6) * 2

              return (
                <Box key={`orb-${o.id}`} flexDirection="column" alignItems="center" width={CELL} overflow="hidden">
                  {Svg ? (
                    <Box key={`sphere-${o.id}`} width={Math.ceil(px / 8)} height={Math.ceil(px / 17)} alignItems="center" justifyContent="center">
                      <Svg source={sphereSvg({ tint: tintFor(o.id), state: o.state, radius: radiusOf(o.size), isSelected: o.id === selectedId })} alt={`${shorts[i]} ${o.state}`} width={px} height={px} />
                    </Box>
                  ) : (
                    <Text key={`sphere-${o.id}`} color={STATE_KEY[o.state]} bold>{o.id === selectedId ? '◉' : '●'}</Text>
                  )}
                  <Button key={`pick-${o.id}`} label={clip(shorts[i] ?? o.title, CELL)} plain onPress={() => select(portsOf($), o.id === selectedId ? null : o.id)} />
                  <Text key={`line-${o.id}`} dimColor wrap="truncate">{clip(lineOf(o), CELL)}</Text>
                </Box>
              )
            })}
          </Box>
        )}
        {selected && (
          <Box key="drawer" flexDirection="column" gap={1}>
            <Box key="top" flexDirection="column">
              <Text key="rule" color="subtle" wrap="truncate">{'─'.repeat(Math.min(width, 80))}</Text>
              <Text key="title" bold wrap="truncate">{selected.title}</Text>
              <Box key="meta" flexDirection="row" columnGap={1}>
                <Text color={STATE_KEY[selected.state]}>{selected.state}</Text>
                {meta ? <Text dimColor>{meta}</Text> : null}
                {Client && selected.state === 'working' && selected.createdAt > 0 ? <Client key="orbit-elapsed" module="./elapsed.tsx" props={{ since: selected.createdAt, after: 0, color: 'inactive' }} /> : null}
              </Box>
            </Box>
            {hasFacts && (
              <Box key="facts" flexDirection="column">
                {steps.map(step => (
                  <Box key={`step-${step.id}`} flexDirection="row" columnGap={1}>
                    <Box key={`icon-${step.id}`} width={2} height={1} alignItems="center" justifyContent="center">
                      {Svg ? (
                        <Svg source={step.isRunning ? iconSvg(step.category as CategoryId) : stillSvg(iconSvg(step.category as CategoryId))} alt={step.verb} width={12} height={12} />
                      ) : (
                        <Text color={tintOf(step.category)}>{GLYPH[step.category as CategoryId] ?? '›'}</Text>
                      )}
                    </Box>
                    <Box key={`verb-${step.id}`} width={verbWidth}>
                      {step.isOk ? <Text bold={step.isRunning} wrap="truncate">{step.verb}</Text> : <Text color="error" wrap="truncate">{step.verb}</Text>}
                    </Box>
                    <Text dimColor wrap="truncate">{step.target}</Text>
                  </Box>
                ))}
                {selected.prs.slice(0, MAX_PRS).map(pr => (
                  <Box key={`pr-${pr.url}`} flexDirection="row" columnGap={1}>
                    <Link href={pr.url} label={`#${pr.number}`} />
                    <Text dimColor wrap="truncate">{`${pr.state} · CI ${MARK[pr.ci]} · CodeRabbit ${MARK[pr.review]}`}</Text>
                  </Box>
                ))}
                {selected.prs.length > MAX_PRS ? <Text key="more-prs" dimColor>{`+${selected.prs.length - MAX_PRS} more`}</Text> : null}
                {shownUsage && (
                  <Box key="usage" flexDirection="row" flexWrap="wrap" columnGap={1}>
                    <Text dimColor>{[shownUsage.cost, `cpu ${Math.round(cpuNow)}%`].filter(Boolean).join(' · ')}</Text>
                    {Svg && shownUsage.cpu.length > 0 ? (
                      <Box key="spark-cpu" width={14} height={1}>
                        <Svg source={sparkSvg(shownUsage.cpu, 100, 14, RING.working.dark)} alt="cpu" width={100} height={14} />
                      </Box>
                    ) : null}
                    {!Svg && shownUsage.cpu.length > 0 ? <Text key="spark-cpu" color="claude">{sparkText(shownUsage.cpu)}</Text> : null}
                    <Text dimColor>{`mem ${Math.round(memNow)} MiB`}</Text>
                    {Svg && shownUsage.memMiB.length > 0 ? (
                      <Box key="spark-mem" width={14} height={1}>
                        <Svg source={sparkSvg(shownUsage.memMiB, 100, 14, RING.waiting.dark)} alt="memory" width={100} height={14} />
                      </Box>
                    ) : null}
                  </Box>
                )}
                {last ? <Text key="final" dimColor wrap="truncate-end">{last}</Text> : null}
              </Box>
            )}
            <Box key="controls" flexDirection="column">
              {Input && <Input key={boxKey(selected.id)} placeholder="Message this orb" submitLabel="send" onSubmit={value => void send(selected.id, value)} />}
              <Box key="actions" flexDirection="row" flexWrap="wrap" columnGap={2}>
                <Link href={selected.url} label="open in Amp" />
                {armed === selected.id ? (
                  <Button key="archive" label="confirm archive" variant="primary" onPress={() => archive(selected.id)} />
                ) : (
                  <Button key="archive" label="archive" plain dimColor onPress={() => archive(selected.id)} />
                )}
                <Button key="close" label="close" plain dimColor onPress={() => select(portsOf($), null)} />
              </Box>
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
