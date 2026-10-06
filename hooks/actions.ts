// What the pane's controls and /orbs do. It takes a `Ports` instead of `$`: the engine follows `$`
// only inside the file that holds it, so register.tsx hands these the closures of `portsOf($)`.
import { ampArchive, ampSend } from './cli'
import { markSent, pollFresh, pollNow, want } from './poller'
import type { Ports } from './ports'

const quiet = () => undefined

export async function openPane(p: Ports, id?: string): Promise<void> {
  await p.openPane()
  await p.isPaneOpen.set(() => true)
  if (id) {
    await p.selected.set(() => id)
    await p.armed.set(() => null)
  }
  // The pane's PR badges and the selected orb's usage are only read while it is open, so read once
  // now (unless a read just finished) rather than leave a stale drawing until the next tick.
  await want(p)
  void pollNow(p, 15_000).catch(quiet)
}

export async function select(p: Ports, id: string | null): Promise<void> {
  await p.selected.set(() => id)
  await p.armed.set(() => null)
  if (!id) return
  // The 30 second cadence only runs while someone asks for it, and the drawer wants its usage now.
  await want(p)
  void pollNow(p).catch(quiet)
}

// Orbs with a send under way. The engine's Input keeps its text after Enter until it is drawn anew,
// and `ampSend` can run for minutes, so a second Enter would send a duplicate instruction to a live
// agent. Module state, like the poller's: a reload starts it empty.
const sending = new Set<string>()
// The pane's sends per orb. The message box is drawn under a key made of the orb and this count, so
// each orb has its own box and a send from the pane draws a new, empty one. A send by Claude
// (orb_send) leaves the box, and whatever is being typed in it, alone.
const boxes = new Map<string, number>()

/** The key of an orb's message box in the pane. */
export const boxKey = (id: string) => `msg-${id}-${boxes.get(id) ?? 0}`

/** Forget every send under way, as a reload does. For tests, which share this module. */
export function resetSending(): void {
  sending.clear()
  boxes.clear()
}

/** Sends `text` to the orb and answers one line: `sent`, or why nothing was sent. One send at a time per orb. */
export async function sendMessage(p: Ports, id: string, text: string, from: 'pane' | 'tool' = 'tool'): Promise<string> {
  const message = text.trim()
  if (!message) return 'nothing to send'
  // No await between the check and the add, so two submits in the same tick cannot both pass.
  if (sending.has(id)) return 'already sending'
  sending.add(id)
  try {
    p.toast('◉ sending…')
    await ampSend(p, id, message)
  } finally {
    sending.delete(id)
  }
  if (from === 'pane') boxes.set(id, (boxes.get(id) ?? 0) + 1)
  // Its write of the orbs draws the pane again, with the new box.
  await markSent(p, id)
  await want(p)
  void pollFresh(p).catch(quiet)

  return 'sent'
}

/** The first press arms the orb, the second archives it. */
export async function pressArchive(p: Ports, id: string): Promise<'armed' | 'archived'> {
  if ((await p.armed.get()) !== id) {
    await p.armed.set(() => id)

    return 'armed'
  }
  await p.armed.set(() => null)
  await ampArchive(p, id)
  await p.orbs.set(list => list.filter(o => o.id !== id))
  if ((await p.selected.get()) === id) await p.selected.set(() => null)

  return 'archived'
}
