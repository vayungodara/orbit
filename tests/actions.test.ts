import { expect, test } from 'claude-code/testing'

import type { Orb, OrbitError, OrbUsage } from '../types'
import { openPane, pressArchive, resetSending, select, sendMessage } from '../hooks/actions'
import { blankOrb } from '../hooks/model'
import { pollNow, resetPoller } from '../hooks/poller'
import type { Cell, Ports } from '../hooks/ports'
import { LIST } from './fixtures'

// The actions take a `Ports`, so these tests hand them a hand-made one: no engine, and a way to see
// exactly what they ran, opened and scheduled.

const NOW = Date.parse('2026-10-05T19:00:30.000Z')
const A = 'T-0f0e0d0c-0001-7000-8000-000000000001'
const B = 'T-0f0e0d0c-0002-7000-8000-000000000002'
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false })
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function cell<T>(value: T): Cell<T> & { value: T } {
  const c = {
    value,
    get: async () => c.value,
    set: async (change: (v: T) => T) => (c.value = change(c.value)),
  }

  return c
}

function lab(o: { archiveFails?: boolean; holdSend?: boolean; holdList?: boolean } = {}) {
  // The poller's timer and the sends under way live in modules the tests share: start each one clean.
  resetPoller()
  resetSending()
  const runs: string[] = []
  const toasts: string[] = []
  // With `holdSend`, `threads continue` answers only when the test calls `release()`: a slow amp.
  let release = () => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  // With `holdList`, every `threads list` answers only when the test calls `releaseList()`.
  let releaseList = () => {}
  const listGate = o.holdList ? new Promise<void>(resolve => (releaseList = resolve)) : null
  const delays: number[] = []
  let opened = 0
  const orbs = cell<Orb[]>([blankOrb(A), blankOrb(B)])
  const selected = cell<string | null>(null)
  const armed = cell<string | null>(null)
  const isPaneOpen = cell(false)
  const ports: Ports = {
    run: async argv => {
      const line = argv.slice(1).join(' ')
      runs.push(line)
      if (o.archiveFails && line.startsWith('threads archive')) return { exitCode: 1, stdout: '', stderr: 'Error: nope', isStdoutTruncated: false }
      if (line.startsWith('threads list')) {
        await listGate

        return ok(JSON.stringify(LIST))
      }
      if (o.holdSend && line.startsWith('threads continue')) await held

      return ok('')
    },
    home: async () => '/Users/test',
    exists: async () => false,
    now: async () => NOW,
    after: ms => {
      delays.push(ms)

      return { cancel: () => undefined }
    },
    toast: text => {
      toasts.push(text)
    },
    openPane: async () => {
      opened += 1
    },
    checkTool: async () => ({ decision: 'allow' }),
    store: { get: async () => undefined, set: async () => undefined },
    orbs,
    selected,
    usage: cell<OrbUsage | null>(null),
    error: cell<OrbitError | null>(null),
    armed,
    isPaneOpen,
  }

  return { ports, runs, toasts, delays, orbs, selected, armed, isPaneOpen, release, releaseList, opened: () => opened }
}

test('openPane opens the pane, marks it open and asks for the 30 second cadence', async () => {
  const w = lab()
  await openPane(w.ports)
  await settle()
  expect(w.opened()).toBe(1)
  expect(w.isPaneOpen.value).toBe(true)
  expect(w.selected.value).toBeNull()
  expect(w.delays).toContain(30_000)
})

test('openPane with an id selects that orb and disarms archive', async () => {
  const w = lab()
  w.armed.value = B
  await openPane(w.ports, A)
  await settle()
  expect(w.selected.value).toBe(A)
  expect(w.armed.value).toBeNull()
})

test('select picks an orb, disarms archive, and reads Amp now', async () => {
  const w = lab()
  w.armed.value = A
  await select(w.ports, B)
  await settle()
  expect(w.selected.value).toBe(B)
  expect(w.armed.value).toBeNull()
  expect(w.runs.some(r => r.startsWith('threads list'))).toBe(true)
  expect(w.delays).toContain(30_000)
})

test('select(null) closes the drawer and reads nothing', async () => {
  const w = lab()
  w.selected.value = A
  w.armed.value = A
  await select(w.ports, null)
  await settle()
  expect(w.selected.value).toBeNull()
  expect(w.armed.value).toBeNull()
  expect(w.runs).toEqual([])
})

test('sendMessage trims, refuses an empty message, and says what it did', async () => {
  const w = lab()
  expect(await sendMessage(w.ports, A, '   \n ')).toBe('nothing to send')
  expect(w.runs).toEqual([])
  expect(await sendMessage(w.ports, A, '  Fix the nit.  ')).toBe('sent')
  expect(w.runs).toContain(`threads continue ${A} --orb-execute --execute=Fix the nit.`)
})

test('sendMessage never sends to something that is not a thread id', async () => {
  const w = lab()
  await expect(sendMessage(w.ports, '--help', 'hi')).rejects.toThrow('not an Amp thread id')
  expect(w.runs).toEqual([])
})

test('pressArchive: the first press arms, the second archives and forgets the orb', async () => {
  const w = lab()
  w.selected.value = A
  expect(await pressArchive(w.ports, A)).toBe('armed')
  expect(w.armed.value).toBe(A)
  expect(w.runs).toEqual([])
  expect(await pressArchive(w.ports, A)).toBe('archived')
  expect(w.runs).toEqual([`threads archive ${A}`])
  expect(w.armed.value).toBeNull()
  expect(w.orbs.value.map(o => o.id)).toEqual([B])
  expect(w.selected.value).toBeNull()
})

test('pressArchive on another orb leaves the drawer open, and a press on a different orb re-arms', async () => {
  const w = lab()
  w.selected.value = A
  w.armed.value = A
  // B was not the armed one, so this is a first press for B, not a confirmation.
  expect(await pressArchive(w.ports, B)).toBe('armed')
  expect(w.armed.value).toBe(B)
  expect(await pressArchive(w.ports, B)).toBe('archived')
  expect(w.selected.value).toBe(A)
  expect(w.orbs.value.map(o => o.id)).toEqual([A])
})

test('a failed archive keeps the orb and starts over', async () => {
  const w = lab({ archiveFails: true })
  await pressArchive(w.ports, A)
  await expect(pressArchive(w.ports, A)).rejects.toThrow('Error: nope')
  expect(w.orbs.value.map(o => o.id)).toEqual([A, B])
  expect(w.armed.value).toBeNull()
})

test('a second send to an orb that is still sending is refused, and nothing is sent twice', async () => {
  const w = lab({ holdSend: true })
  const first = sendMessage(w.ports, A, 'Fix the nit.')
  await settle()
  expect(await sendMessage(w.ports, A, 'Fix the nit.')).toBe('already sending')
  expect(await sendMessage(w.ports, A, 'And another thing.')).toBe('already sending')
  expect(w.runs.filter(r => r.startsWith('threads continue'))).toEqual([`threads continue ${A} --orb-execute --execute=Fix the nit.`])
  w.release()
  expect(await first).toBe('sent')
  expect(w.runs.filter(r => r.startsWith('threads continue')).length).toBe(1)
})

test('once the first send is done, a new one goes through', async () => {
  const w = lab()
  expect(await sendMessage(w.ports, A, 'one')).toBe('sent')
  expect(await sendMessage(w.ports, A, 'two')).toBe('sent')
  expect(w.runs.filter(r => r.startsWith('threads continue')).length).toBe(2)
})

test('a send that fails frees the orb for the next one', async () => {
  const w = lab()
  await expect(sendMessage(w.ports, 'not-an-id', 'hi')).rejects.toThrow('not an Amp thread id')
  expect(await sendMessage(w.ports, A, 'hi')).toBe('sent')
})

test('the send to one orb does not hold back another', async () => {
  const w = lab({ holdSend: true })
  const first = sendMessage(w.ports, A, 'to A')
  await settle()
  const second = sendMessage(w.ports, B, 'to B')
  await settle()
  expect(w.runs.filter(r => r.startsWith('threads continue')).length).toBe(2)
  w.release()
  expect([await first, await second]).toEqual(['sent', 'sent'])
})

test('sending is toasted at once, before amp answers, and an empty message toasts nothing', async () => {
  const w = lab({ holdSend: true })
  expect(await sendMessage(w.ports, A, '   ')).toBe('nothing to send')
  expect(w.toasts).toEqual([])
  const first = sendMessage(w.ports, A, 'Fix the nit.')
  await settle()
  expect(w.toasts).toEqual(['◉ sending…'])
  w.release()
  await first
})

// A sent message starts a turn: the orb reads working at once, and nothing read from before the send undoes that.

// A as Amp listed it, with its first turn read and ended: the list shows no change for it.
const doneA = (): Orb => ({ ...blankOrb(A), title: LIST[0]!.title, state: 'done', isEnded: true, agentState: 'idle', finalText: 'Old report.', updatedAt: Date.parse(LIST[0]!.updated), messageCount: LIST[0]!.messageCount, changedAt: NOW - 600_000, exportedAt: NOW - 500_000 })

test('a sent message marks the orb working at once, before any read of Amp', async () => {
  const w = lab({ holdList: true })
  w.orbs.value = [doneA(), blankOrb(B)]
  expect(await sendMessage(w.ports, A, 'Do more.')).toBe('sent')
  expect(w.orbs.value.find(o => o.id === A)).toMatchObject({ state: 'working', changedAt: NOW, isEnded: false })
  w.releaseList()
})

test('a read that began before the send cannot put the orb back to done when it lands', async () => {
  const w = lab({ holdList: true })
  w.orbs.value = [doneA(), blankOrb(B)]
  const before = pollNow(w.ports)
  await settle()
  expect(await sendMessage(w.ports, A, 'Do more.')).toBe('sent')
  w.releaseList()
  await before
  await settle()
  expect(w.orbs.value.find(o => o.id === A)?.state).toBe('working')
})

test('the read after a send starts after any read already under way, which may predate the message', async () => {
  const w = lab({ holdList: true })
  const lists = () => w.runs.filter(r => r.startsWith('threads list')).length
  const before = pollNow(w.ports)
  await settle()
  expect(lists()).toBe(1)
  expect(await sendMessage(w.ports, A, 'Do more.')).toBe('sent')
  w.releaseList()
  await before
  for (let i = 0; i < 5; i += 1) await settle()
  expect(lists()).toBe(2)
})
