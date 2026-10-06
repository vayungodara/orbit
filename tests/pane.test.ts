import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { exportJson, LIST } from './fixtures'

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const NOW = Date.parse('2026-10-05T19:00:30.000Z')
const ID = 'T-0f0e0d0c-0001-7000-8000-000000000001'
const ID2 = 'T-0f0e0d0c-0002-7000-8000-000000000002'

function prLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `https://github.com/acme/acme-api/pull/${20 + i}`).join(' ')
}

type Tool = { id: string; name: string; input: Record<string, unknown>; done?: boolean }
type Options = { title?: string; text?: string; sendError?: string; isEmpty?: boolean; sendMs?: number; tools?: Tool[] }

const TESTING: Tool[] = [{ id: 'TU-1', name: 'shell_command', input: { command: 'cargo test' } }]

function world(on: On, { title = 'acme-api: Wave 1B cooldowns', text = 'Opened https://github.com/acme/acme-api/pull/28', sendError, isEmpty = false, sendMs = 0, tools = TESTING }: Options = {}) {
  const runs: string[] = []
  const toasts: string[] = []
  const panes: string[] = []
  // The engine loads its own copy of the hooks modules for each test, so no timer or send carries over.
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.start', async () => ({ cwd: '/tmp' }) as never)
  on('tool.check', async () => ({ decision: 'allow' }) as never)
  on('tool.register', async ($, e) => ({ value: { tool: `mcp__orbit__${(e as { name: string }).name}` } }) as never)
  on('command.register', async ($, e) => ({ value: { command: (e as { name: string }).name } }) as never)
  on('env.get', async ($, e, next) => ((e as { name: string }).name === 'HOME' ? ({ value: '/Users/test' } as never) : next(e)))
  on('fs.exists', async () => ({ value: false }) as never)
  on('ui.open', async ($, e) => {
    panes.push(String((e as { id: string }).id))

    return { value: { isPlaced: true as const } } as never
  })
  on('ui.toast', async ($, e) => {
    toasts.push(String((e as { text: string }).text))

    return { value: undefined } as never
  })
  on('process.run', async ($, e) => {
    const argv = e.argv.slice(1).join(' ')
    runs.push(argv)
    if (argv.startsWith('threads list')) return ok(JSON.stringify(isEmpty ? [] : LIST.map((r, i) => (i === 0 ? { ...r, title } : r)))) as never
    if (argv.startsWith('threads export')) return ok(exportJson({ state: 'tool_use', text, stop: 'tool_use', tools })) as never
    // A slow amp: the send takes this long on the real clock (the mocked one never moves by itself).
    if (sendMs && argv.startsWith('threads continue')) await new Promise(resolve => setTimeout(resolve, sendMs))
    if (sendError && argv.startsWith('threads continue')) return { value: { exitCode: 1, stdout: '', stderr: sendError, isStdoutTruncated: false, isStderrTruncated: false } } as never
    if (argv.startsWith('threads usage')) return ok('Cost: $0.18\n| 2.55% / 2 cores | 236 MiB / 3931 MiB (6.0%) |\n| 44.89% / 2 cores | 562 MiB / 3931 MiB (14.3%) |') as never
    if (argv.startsWith('pr view')) return ok(JSON.stringify({ state: 'OPEN', statusCheckRollup: [{ conclusion: 'SUCCESS', name: 'build' }] })) as never

    return ok('') as never
  })

  return { runs, toasts, panes, clock }
}

// The message box of an orb, after `n` messages sent from the pane.
const box = (id: string, n = 0) => `msg-${id}-${n}`

const PANE_PROPS = { title: 'orbit', isFocused: false, bodyColumns: 80, placement: 'dock' } as never

async function open($: Engine, args = '') {
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)

  return $.command.run({ command: 'orbs', args } as never)
}

const mount = ($: Engine, surface: 'terminal' | 'desktop', props = PANE_PROPS) =>
  $.ui.mount({ plugin: 'orbit', surface, component: 'Pane', requestId: 'orbit', props })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the constellation shows each orb, and pressing one opens its drawer`, async ($, on) => {
    world(on)
    await open($)
    const pane = await mount($, surface)
    expect(await pane.find({ key: `pick-${ID}` })).toBeDefined()
    expect(await pane.find({ key: `pick-${ID2}` })).toBeDefined()
    // The sphere is an Svg on the desktop; the terminal draws a glyph.
    if (surface === 'desktop') expect(await pane.find({ type: 'Svg' })).toBeDefined()
    else expect(await pane.find({ type: 'Svg' })).toBeUndefined()
    expect(await pane.find({ type: 'Input' })).toBeUndefined()
    await pane.press({ key: `pick-${ID}` })
    expect(await pane.find({ text: /running tests|testing/ })).toBeDefined()
    expect(await pane.find({ type: 'Input' })).toBeDefined()
    expect(await pane.find({ type: 'Link', text: /open in Amp/ })).toBeDefined()
    // A working orb's drawer counts its time on the surface's own clock.
    expect(await pane.find({ type: 'Client' })).toBeDefined()
    // Pressing the same orb again closes its drawer.
    await pane.press({ key: `pick-${ID}` })
    expect(await pane.find({ type: 'Input' })).toBeUndefined()
  })
}

test('/orbs opens the pane under the id the render hook answers to', async ($, on) => {
  const { panes } = world(on)
  await open($)
  expect(panes).toEqual(['orbit'])
  const pane = await $.ui.mount({ plugin: 'orbit', surface: 'terminal', component: 'Pane', requestId: panes[0]!, props: PANE_PROPS })
  expect(await pane.find({ key: 'head' })).toBeDefined()
})

test('/orbs with a thread id opens its drawer at once', async ($, on) => {
  world(on)
  const out = await open($, ID2)
  expect(String((out as { text?: string }).text)).toContain('orbit')
  const pane = await mount($, 'desktop')
  expect(await pane.find({ type: 'Input' })).toBeDefined()
  expect(await pane.find({ key: 'drawer' })).toBeDefined()
})

test('/orbs with something that is not a thread id just opens the pane', async ($, on) => {
  world(on)
  await open($, 'hello there')
  const pane = await mount($, 'desktop')
  expect(await pane.find({ key: `pick-${ID}` })).toBeDefined()
  expect(await pane.find({ type: 'Input' })).toBeUndefined()
})

test('the header counts orbs by state', async ($, on) => {
  world(on)
  await open($)
  const pane = await mount($, 'terminal')
  expect(await pane.find({ text: /2 working/ })).toBeDefined()
})

test('with no orbs the pane says so instead of drawing an empty sky', async ($, on) => {
  world(on, { isEmpty: true })
  await open($)
  const pane = await mount($, 'desktop')
  expect(await pane.find({ text: /No active orbs/ })).toBeDefined()
  expect(await pane.find({ key: 'sky' })).toBeUndefined()
})

test('empty message is not sent; a real one is, with the real argv', async ($, on) => {
  const { runs, toasts } = world(on)
  await open($)
  const pane = await mount($, 'desktop')
  await pane.press({ key: `pick-${ID}` })
  await pane.input({ key: box(ID), text: '   ' })
  expect(runs.some(r => r.startsWith('threads continue'))).toBe(false)
  await pane.input({ key: box(ID), text: '  Fix the nit.  ' })
  expect(runs).toContain(`threads continue ${ID} --orb-execute --execute=Fix the nit.`)
  expect(toasts.some(t => t.includes('message sent'))).toBe(true)
})

test('a second Enter while the first send is still running sends nothing more', async ($, on) => {
  const { runs, toasts } = world(on, { sendMs: 60 })
  await open($)
  const pane = await mount($, 'desktop')
  await pane.press({ key: `pick-${ID}` })
  await Promise.all([pane.input({ key: box(ID), text: 'Fix the nit.' }), pane.input({ key: box(ID), text: 'Fix the nit.' })])
  // The Input does not hold the press for the send: the answer is not in yet, the first toast is.
  expect(toasts.some(t => t.includes('message sent'))).toBe(false)
  expect(toasts.filter(t => t.includes('sending…')).length).toBe(1)
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(runs.filter(r => r.startsWith('threads continue'))).toEqual([`threads continue ${ID} --orb-execute --execute=Fix the nit.`])
  expect(toasts.filter(t => t.includes('message sent')).length).toBe(1)
  expect(toasts.some(t => t.includes('still sending'))).toBe(true)
})

test('a failing send is toasted, not thrown', async ($, on) => {
  const { toasts } = world(on, { sendError: 'Error: orb is asleep' })
  await open($)
  const pane = await mount($, 'desktop')
  await pane.press({ key: `pick-${ID}` })
  await pane.input({ key: box(ID), text: 'hello' })
  expect(toasts.some(t => t.includes('orb is asleep'))).toBe(true)
  expect(toasts.some(t => t.includes('message sent'))).toBe(false)
})

test('archive needs a second press', async ($, on) => {
  const { runs } = world(on)
  await open($)
  const pane = await mount($, 'desktop')
  await pane.press({ key: `pick-${ID}` })
  await pane.press({ key: 'archive' })
  expect(runs.some(r => r.startsWith('threads archive'))).toBe(false)
  expect(await pane.find({ text: /confirm archive/ })).toBeDefined()
  await pane.press({ key: 'archive' })
  expect(runs).toContain(`threads archive ${ID}`)
  // The archived orb leaves the constellation and its drawer closes.
  expect(await pane.find({ key: `pick-${ID}` })).toBeUndefined()
  expect(await pane.find({ type: 'Input' })).toBeUndefined()
})

test('selecting another orb disarms archive', async ($, on) => {
  const { runs } = world(on)
  await open($)
  const pane = await mount($, 'desktop')
  await pane.press({ key: `pick-${ID}` })
  await pane.press({ key: 'archive' })
  await pane.press({ key: `pick-${ID2}` })
  await pane.press({ key: `pick-${ID}` })
  expect(await pane.find({ text: /confirm archive/ })).toBeUndefined()
  await pane.press({ key: 'archive' })
  expect(runs.some(r => r.startsWith('threads archive'))).toBe(false)
})

test('long title is clipped to the cell', async ($, on) => {
  world(on, { title: `acme-api: ${'very long title '.repeat(10)}` })
  await open($)
  const pane = await mount($, 'terminal')
  const pick = await pane.find({ key: `pick-${ID}` })
  expect([...String(pick?.text ?? '')].length).toBeLessThanOrEqual(16)
})

test('the drawer lists at most five PRs', async ($, on) => {
  world(on, { text: `Opened ${prLines(7)}` })
  await open($)
  const pane = await mount($, 'desktop')
  await pane.press({ key: `pick-${ID}` })
  expect((await pane.findAll({ type: 'Link', text: /^#\d+$/ })).length).toBe(5)
})

test('the drawer shows usage once it has been read', async ($, on) => {
  world(on)
  await open($)
  const pane = await mount($, 'desktop')
  await pane.press({ key: `pick-${ID}` })
  expect(await pane.find({ key: 'usage' })).toBeDefined()
  expect(await pane.find({ text: /\$0\.18/ })).toBeDefined()
})

test('terminal: the usage row labels memory in MiB and draws cpu as a text sparkline', async ($, on) => {
  world(on)
  await open($)
  const pane = await mount($, 'terminal')
  await pane.press({ key: `pick-${ID}` })
  expect(await pane.find({ text: /^mem 562 MiB$/ })).toBeDefined()
  // cpu 2.55% then 44.89%: the lowest bar, then the full one.
  expect(await pane.find({ type: 'Text', text: /^▁█$/ })).toBeDefined()
})

test('the pane has no view switch: it shows only the orbs that need attention', async ($, on) => {
  world(on)
  await open($)
  const pane = await mount($, 'terminal')
  expect(await pane.find({ key: 'filter' })).toBeUndefined()
  expect(await pane.find({ key: 'head' })).toBeDefined()
})

test('an open pane keeps reading Amp every 30 seconds for the selected orb', async ($, on) => {
  const { runs, clock } = world(on)
  await open($)
  const pane = await mount($, 'desktop')
  await pane.press({ key: `pick-${ID}` })
  const lists = () => runs.filter(r => r.startsWith('threads list')).length
  const before = lists()
  await clock.advance(31_000)
  await clock.settle()
  expect(lists()).toBeGreaterThan(before)
})

test('only the running step\'s icon moves: a finished step\'s icon is still', async ($, on) => {
  world(on, { tools: [{ id: 'TU-0', name: 'shell_command', input: { command: 'cargo build' }, done: true }, ...TESTING] })
  await open($)
  const pane = await mount($, 'desktop')
  await pane.press({ key: `pick-${ID}` })
  const source = async (key: string) => String(((await pane.find({ key }))?.children[0] as { props: { source: string } }).props.source)
  expect(await source('icon-TU-0')).not.toContain('<animate')
  expect(await source('icon-TU-1')).toContain('<animate')
})

test('after a send from the pane the message box is a new, empty one, so Enter cannot send it twice', async ($, on) => {
  const { runs } = world(on)
  await open($)
  const pane = await mount($, 'desktop')
  await pane.press({ key: `pick-${ID}` })
  await pane.input({ key: box(ID), text: 'Fix the nit.' })
  expect(runs.filter(r => r.startsWith('threads continue'))).toHaveLength(1)
  expect(await pane.find({ key: box(ID) })).toBeUndefined()
  expect(await pane.find({ key: box(ID, 1) })).toBeDefined()
})

test('a failed send keeps the box, and its text, for another try', async ($, on) => {
  world(on, { sendError: 'Error: orb is asleep' })
  await open($)
  const pane = await mount($, 'desktop')
  await pane.press({ key: `pick-${ID}` })
  await pane.input({ key: box(ID), text: 'hello' })
  expect(await pane.find({ key: box(ID) })).toBeDefined()
})

test('each orb has its own message box: text typed for one is never sent to another', async ($, on) => {
  const { runs } = world(on)
  await open($)
  const pane = await mount($, 'desktop')
  await pane.press({ key: `pick-${ID}` })
  await pane.input({ key: box(ID), text: 'for the first orb', kind: 'change' })
  await pane.press({ key: `pick-${ID2}` })
  expect(await pane.find({ key: box(ID) })).toBeUndefined()
  expect(await pane.find({ key: box(ID2) })).toBeDefined()
  await pane.input({ key: box(ID2), text: 'for the second orb' })
  expect(runs.filter(r => r.startsWith('threads continue'))).toEqual([`threads continue ${ID2} --orb-execute --execute=for the second orb`])
})

test('a message Claude sends with orb_send leaves the box, and whatever is typed in it, alone', async ($, on) => {
  world(on)
  await open($)
  const pane = await mount($, 'desktop')
  await pane.press({ key: `pick-${ID}` })
  await pane.input({ key: box(ID), text: 'half a thought', kind: 'change' })
  await $.tool.call({ tool: 'mcp__orbit__orb_send', id: ID, message: 'Fix it.' } as never)
  expect(await pane.find({ key: box(ID) })).toBeDefined()
})

test('two PRs with the same number in different repos each get their own row', async ($, on) => {
  world(on, { text: 'Opened https://github.com/a/x/pull/7 and https://github.com/b/y/pull/7' })
  await open($)
  const pane = await mount($, 'desktop')
  await pane.press({ key: `pick-${ID}` })
  // Sibling rows need keys of their own, or a surface may reuse one row's drawing for the other.
  const keys = (await pane.findAll({ type: 'Box' })).map(b => b.key ?? '').filter(key => key.startsWith('pr-'))
  expect(keys).toHaveLength(2)
  expect(new Set(keys).size).toBe(2)
  expect((await pane.findAll({ type: 'Link', text: /^#7$/ })).map(link => link.props.href)).toEqual(['https://github.com/a/x/pull/7', 'https://github.com/b/y/pull/7'])
})
