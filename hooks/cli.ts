// The `amp`, `gh` and `jq` calls (the jq pipe runs under /bin/bash, which has pipefail on macOS and Linux alike; poller.ts runs osascript and
// tools.ts runs sleep). Every call has a timeout, argv is never built by a shell (the jq pipe's
// script takes everything as positional arguments), and thread ids are checked before they reach
// argv. Values that reach amp as options use the `--name=value` form, so a value that starts with
// "-" is never read as a flag of its own.
//
// The host follows `$` only into functions declared in the file that holds it, never across an
// import, so these functions take a `Host` (closures over `$`) instead of `$` itself: the Ports
// that register.tsx builds are one.
import type { OrbCheck, OrbPr } from '../types'
import { parseList, type ListRow } from './model'

export type Host = {
  run: (argv: readonly string[], init: { timeoutMs: number; stdin?: string }) => Promise<{ exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean }>
  home: () => Promise<string | undefined>
  exists: (path: string) => Promise<boolean>
}

export class CliError extends Error {}

/**
 * amp was launched for `orb_start` and did not say which thread it started: it timed out, or ended
 * without a thread URL. The orb may be running anyway. `urls` is what it printed that looks like a link.
 */
export class StartUnsure extends CliError {
  constructor(message: string, readonly urls: string[]) {
    super(message)
  }
}

const THREAD = /^T-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
export const isThreadId = (id: string) => THREAD.test(id)

// Only a path that was found is remembered: a failed lookup must not pin the bare name forever.
let amp: string | null = null
let gh: string | null = null
let hasJq = false

export function resetBins(): void {
  amp = null
  gh = null
  hasJq = false
}

const JQ = '/usr/bin/jq'

// The desktop app starts sessions with a bare PATH, so look in the usual install places first.
async function bin(host: Host, name: 'amp' | 'gh'): Promise<string> {
  if (name === 'amp' && amp) return amp
  if (name === 'gh' && gh) return gh
  let home = ''
  try {
    home = (await host.home()) ?? ''
  } catch {
    // No HOME: only the fixed paths are tried.
  }
  const fixed = name === 'amp' ? [] : ['/opt/homebrew/bin/gh', '/usr/local/bin/gh']
  const homed = name === 'amp' && home.startsWith('/') ? [`${home}/.local/bin/amp`, `${home}/.amp/bin/amp`] : []
  for (const path of [...homed, ...fixed]) {
    if (await host.exists(path).catch(() => false)) {
      if (name === 'amp') amp = path
      else gh = path

      return path
    }
  }

  return name
}

async function exec(host: Host, argv: string[], label: string, timeoutMs: number, stdin?: string): Promise<string> {
  let out
  try {
    out = await host.run(argv, stdin === undefined ? { timeoutMs } : { timeoutMs, stdin })
  } catch (error) {
    throw new CliError(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (out.exitCode !== 0) {
    const first = out.stderr.split('\n').map(line => line.trim()).find(Boolean)
    throw new CliError(first ?? `${label} exited ${out.exitCode}`)
  }
  if (out.isStdoutTruncated) throw new CliError(`${label} output was cut at 4 MiB`)

  return out.stdout
}

async function run(host: Host, name: 'amp' | 'gh', args: string[], timeoutMs: number, stdin?: string): Promise<string> {
  return exec(host, [await bin(host, name), ...args], `${name} ${args.slice(0, 2).join(' ')}`, timeoutMs, stdin)
}

function checkId(id: string): void {
  if (!isThreadId(id)) throw new CliError(`not an Amp thread id: ${id.slice(0, 60)}`)
}

export async function ampList(host: Host): Promise<ListRow[]> {
  return parseList(await run(host, 'amp', ['threads', 'list', '--json', '--limit', '30'], 20_000))
}

// Real exports run past the 4 MiB cap on `process.run`'s stdout (a 12-message thread was 5.1 MB), so
// when the system jq is there it shrinks the JSON at the source: long tool output is dropped and
// long inputs are clipped, and what `parseExport` reads is kept as it was.
export const EXPORT_FILTER =
  '{id, created, agentMode, meta: {lastKnownAgentState: .meta.lastKnownAgentState}, messages: [.messages[] | {role, state, content: [(.content // [])[]? | if .type == "text" then (if .text then {type, text} else empty end) elif .type == "tool_use" then {type, id, name, input: ((.input // {}) | with_entries(.value |= (tostring | .[0:300])))} elif .type == "tool_result" then {type, toolUseID, run: {status: .run.status, error: (if .run.error then (.run.error | tostring | .[0:200]) else null end)}} else empty end]}]}'

// Everything is a positional argument; nothing is interpolated into the script.
const EXPORT_PIPE = `set -o pipefail; "$1" threads export "$2" | ${JQ} -c "$3"`

export async function ampExport(host: Host, id: string): Promise<string> {
  checkId(id)
  if (!hasJq) hasJq = await host.exists(JQ).catch(() => false)
  if (!hasJq) return run(host, 'amp', ['threads', 'export', id], 60_000)

  return exec(host, ['/bin/bash', '-c', EXPORT_PIPE, 'bash', await bin(host, 'amp'), id, EXPORT_FILTER], 'amp threads export', 60_000)
}

export async function ampUsage(host: Host, id: string): Promise<string> {
  checkId(id)

  return run(host, 'amp', ['threads', 'usage', id], 30_000)
}

const PROJECT = /^[\w.][\w.-]*\/[\w.-]+$/

const THREAD_URL = /https:\/\/ampcode\.com\/threads\/(T-[0-9a-f-]+)/

// What amp printed that looks like a link, for a start whose thread is not known: a few, clipped.
function linksIn(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[^\s"'<>]+/g) ?? [])].slice(0, 3).map(url => url.slice(0, 200))
}

// Once amp is launched, an orb may start whatever comes back, so every failure after the launch is a
// StartUnsure, never a plain error that invites starting it again. The URL is looked for on stdout,
// then on stderr.
export async function ampStart(host: Host, o: { title: string; prompt: string; project: string; mode: string; size: string }): Promise<{ id: string; url: string }> {
  if (!PROJECT.test(o.project)) throw new CliError(`not an Amp project (owner/name): ${o.project.slice(0, 60)}`)
  const args = ['-ox', `--project=${o.project}`, `--title=${o.title}`, `--mode=${o.mode}`, `--orb-size=${o.size}`, '--no-archive-after-execute']
  const argv = [await bin(host, 'amp'), ...args]
  let out
  try {
    out = await host.run(argv, { timeoutMs: 120_000, stdin: o.prompt })
  } catch (error) {
    throw new StartUnsure(`amp -ox: ${error instanceof Error ? error.message : String(error)}`, [])
  }
  const id = [out.stdout, out.stderr].map(text => THREAD_URL.exec(text)?.[1]).find(found => !!found && isThreadId(found))
  if (id) return { id, url: `https://ampcode.com/threads/${id}` }
  const first = out.stderr.split('\n').map(line => line.trim()).find(Boolean)
  const why = out.exitCode !== 0 ? (first ?? `amp -ox exited ${out.exitCode}`) : 'amp did not print a thread URL'

  throw new StartUnsure(why, linksIn(`${out.stdout}\n${out.stderr}`))
}

export async function ampSend(host: Host, id: string, message: string): Promise<void> {
  checkId(id)
  await run(host, 'amp', ['threads', 'continue', id, '--orb-execute', `--execute=${message}`], 120_000, '')
}

export async function ampArchive(host: Host, id: string): Promise<void> {
  checkId(id)
  await run(host, 'amp', ['threads', 'archive', id], 30_000)
}

const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']
const PASSED = ['SUCCESS', 'SKIPPED', 'NEUTRAL']

export function checksOf(rollup: unknown): { ci: OrbCheck; review: OrbCheck } {
  const items = Array.isArray(rollup) ? (rollup as Record<string, unknown>[]) : []
  const verdict = (xs: Record<string, unknown>[]): OrbCheck => {
    if (xs.length === 0) return 'none'
    const states = xs.map(x => String(x.conclusion || x.state || x.status || '').toUpperCase())
    if (states.some(s => FAILED.includes(s))) return 'fail'
    if (states.every(s => PASSED.includes(s))) return 'pass'

    return 'pending'
  }
  const isRabbit = (x: Record<string, unknown>) => /coderabbit/i.test(String(x.name ?? x.context ?? ''))

  return { ci: verdict(items.filter(x => !isRabbit(x))), review: verdict(items.filter(isRabbit)) }
}

export async function ghPr(host: Host, url: string): Promise<Pick<OrbPr, 'state' | 'ci' | 'review'>> {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url)) throw new CliError('not a GitHub PR URL')
  const data = JSON.parse(await run(host, 'gh', ['pr', 'view', url, '--json', 'state,statusCheckRollup'], 20_000)) as { state?: string; statusCheckRollup?: unknown }
  const state = String(data.state ?? '').toLowerCase()

  return { state: state === 'open' || state === 'merged' || state === 'closed' ? state : 'unknown', ...checksOf(data.statusCheckRollup) }
}
