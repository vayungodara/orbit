import { expect, test } from 'claude-code/testing'

import { ampArchive, ampExport, ampList, ampSend, ampStart, checksOf, CliError, EXPORT_FILTER, ghPr, isThreadId, resetBins, StartUnsure, type Host } from '../hooks/cli'
import { LIST } from './fixtures'

type Answer = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean }
const ok = (stdout: string): Answer => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false })
const fail = (stderr: string): Answer => ({ exitCode: 1, stdout: '', stderr, isStdoutTruncated: false })

const ID = 'T-0f0e0d0c-0001-7000-8000-000000000001'

// The CLI adapters take a `Host`, so these tests hand them a recording one: no engine, no process.
// `has` says which paths exist; `home` is what HOME reads as. The binary cache starts empty.
function world(answer: (argv: readonly string[]) => Answer | Promise<never>, o: { has?: (path: string) => boolean; home?: () => Promise<string | undefined> } = {}) {
  resetBins()
  const calls: { argv: readonly string[]; stdin?: string; timeoutMs: number }[] = []
  const lookups: string[] = []
  const host: Host = {
    run: async (argv, init) => {
      calls.push({ argv, stdin: init.stdin, timeoutMs: init.timeoutMs })

      return answer(argv)
    },
    home: o.home ?? (async () => '/Users/test'),
    exists: async path => {
      lookups.push(path)

      return o.has?.(path) ?? false
    },
  }

  return { host, calls, lookups }
}

test('ampList runs amp threads list as JSON and parses it', async () => {
  const { host, calls } = world(() => ok(JSON.stringify(LIST)))
  const rows = await ampList(host)
  expect(rows.length).toBe(3)
  expect(calls[0]!.argv.slice(1)).toEqual(['threads', 'list', '--json', '--limit', '30'])
  expect(calls[0]!.stdin).toBe(undefined)
  expect(calls[0]!.timeoutMs).toBe(20_000)
})

test('a failing amp call throws a CliError with the first stderr line', async () => {
  const { host } = world(() => fail('Error: not logged in\nmore'))
  let caught: unknown
  try { await ampList(host) } catch (error) { caught = error }
  expect(caught instanceof CliError).toBe(true)
  expect((caught as Error).message).toBe('Error: not logged in')
})

test('a call that cannot start or times out becomes a CliError naming the command', async () => {
  const { host } = world(() => Promise.reject(new Error('timed out after 20000ms')) as Promise<never>)
  let caught: unknown
  try { await ampList(host) } catch (error) { caught = error }
  expect(caught instanceof CliError).toBe(true)
  expect((caught as Error).message).toBe('amp threads list: timed out after 20000ms')
})

test('ampStart sends the prompt on stdin with the default flags and reads the thread id', async () => {
  const { host, calls } = world(() => ok('https://ampcode.com/threads/T-0f0e0d0c-0001-7000-8000-000000000001\n'))
  const started = await ampStart(host, { title: 'orbit test', prompt: 'Do it.', project: 'acme/acme-api', mode: 'ultra', size: 'a1.small' })
  expect(started.id).toBe('T-0f0e0d0c-0001-7000-8000-000000000001')
  expect(started.url).toBe('https://ampcode.com/threads/T-0f0e0d0c-0001-7000-8000-000000000001')
  expect(calls[0]!.argv.slice(1)).toEqual(['-ox', '--project=acme/acme-api', '--title=orbit test', '--mode=ultra', '--orb-size=a1.small', '--no-archive-after-execute'])
  expect(calls[0]!.stdin).toBe('Do it.')
})

test('ampSend and ampArchive build the right commands with closed stdin', async () => {
  const { host, calls } = world(() => ok(''))
  await ampSend(host, 'T-0f0e0d0c-0001-7000-8000-000000000001', 'Fix the nit.')
  await ampArchive(host, 'T-0f0e0d0c-0001-7000-8000-000000000001')
  expect(calls[0]!.argv.slice(1)).toEqual(['threads', 'continue', 'T-0f0e0d0c-0001-7000-8000-000000000001', '--orb-execute', '--execute=Fix the nit.'])
  expect(calls[0]!.stdin).toBe('')
  expect(calls[1]!.argv.slice(1)).toEqual(['threads', 'archive', 'T-0f0e0d0c-0001-7000-8000-000000000001'])
})

test('a message that starts with a dash reaches argv only inside --execute=', async () => {
  const { host, calls } = world(() => ok(''))
  await ampSend(host, ID, '- fix the nit')
  await ampSend(host, ID, '--version')
  expect(calls[0]!.argv.slice(1)).toEqual(['threads', 'continue', ID, '--orb-execute', '--execute=- fix the nit'])
  expect(calls[1]!.argv.slice(1)).toEqual(['threads', 'continue', ID, '--orb-execute', '--execute=--version'])
  expect(calls.every(c => !c.argv.includes('-ox') && !c.argv.includes('--version') && !c.argv.includes('- fix the nit'))).toBe(true)
})

test('option values that start with a dash stay inside --name=value, and a bad project is refused', async () => {
  const { host, calls } = world(() => ok('https://ampcode.com/threads/' + ID))
  await ampStart(host, { title: '-x injected', prompt: '- do it', project: 'acme/acme-api', mode: '-m', size: '--orb-size' })
  expect(calls[0]!.argv.slice(1)).toEqual(['-ox', '--project=acme/acme-api', '--title=-x injected', '--mode=-m', '--orb-size=--orb-size', '--no-archive-after-execute'])
  expect(calls[0]!.stdin).toBe('- do it')
  for (const project of ['--version', '-ox/repo', '-x', 'a b/c', 'a/b/c', 'acme/repo; rm -rf /', '']) {
    let caught: unknown
    try { await ampStart(host, { title: 't', prompt: 'p', project, mode: 'ultra', size: 'a1.small' }) } catch (error) { caught = error }
    expect(caught instanceof CliError).toBe(true)
  }
  expect(calls.length).toBe(1)
})

test('amp is looked up in the install places and a found path is remembered', async () => {
  const { host, calls, lookups } = world(() => ok('[]'), { has: path => path === '/Users/test/.local/bin/amp' })
  await ampList(host)
  await ampList(host)
  expect(calls[0]!.argv[0]).toBe('/Users/test/.local/bin/amp')
  expect(calls[1]!.argv[0]).toBe('/Users/test/.local/bin/amp')
  expect(lookups).toEqual(['/Users/test/.local/bin/amp'])
})

test('a failed lookup is not remembered, so amp turns up once it is installed', async () => {
  let installed = false
  const { host, calls } = world(() => ok('[]'), { has: path => installed && path === '/Users/test/.amp/bin/amp' })
  await ampList(host)
  installed = true
  await ampList(host)
  expect(calls[0]!.argv[0]).toBe('amp')
  expect(calls[1]!.argv[0]).toBe('/Users/test/.amp/bin/amp')
})

test('without a HOME only the fixed paths are tried, and a HOME that throws counts as none', async () => {
  const empty = world(() => ok('[]'), { home: async () => undefined, has: () => true })
  await ampList(empty.host)
  expect(empty.calls[0]!.argv[0]).toBe('amp')
  expect(empty.lookups).toEqual([])
  const broken = world(() => ok('{}'), { home: () => Promise.reject(new Error('no env')), has: path => path === '/opt/homebrew/bin/gh' })
  await ghPr(broken.host, 'https://github.com/acme/acme-api/pull/7').catch(() => undefined)
  expect(broken.calls[0]!.argv[0]).toBe('/opt/homebrew/bin/gh')
})

test('a bad thread id never reaches argv', async () => {
  const { host, calls } = world(() => ok(''))
  let caught: unknown
  try { await ampArchive(host, 'T-1; rm -rf /') } catch (error) { caught = error }
  expect(caught instanceof CliError).toBe(true)
  expect(calls.length).toBe(0)
})

test('isThreadId accepts only Amp thread ids', async () => {
  expect(isThreadId('T-0f0e0d0c-0001-7000-8000-000000000001')).toBe(true)
  expect(isThreadId('T-1; rm -rf /')).toBe(false)
})

test('checksOf separates CodeRabbit from CI', async () => {
  expect(checksOf([{ name: 'fmt, clippy', conclusion: 'SUCCESS' }, { name: 'CodeRabbit', status: 'IN_PROGRESS' }])).toEqual({ ci: 'pass', review: 'pending' })
  expect(checksOf([{ name: 'cargo check', conclusion: 'FAILURE' }, { context: 'CodeRabbit', state: 'SUCCESS' }])).toEqual({ ci: 'fail', review: 'pass' })
  expect(checksOf([])).toEqual({ ci: 'none', review: 'none' })
})

test('ghPr reads state and checks, and refuses anything but a GitHub PR URL', async () => {
  const url = 'https://github.com/acme/acme-api/pull/7'
  const { host, calls } = world(() => ok(JSON.stringify({ state: 'OPEN', statusCheckRollup: [{ name: 'cargo check', conclusion: 'SUCCESS' }] })))
  expect(await ghPr(host, url)).toEqual({ state: 'open', ci: 'pass', review: 'none' })
  expect(calls[0]!.argv.slice(1)).toEqual(['pr', 'view', url, '--json', 'state,statusCheckRollup'])
  let caught: unknown
  try { await ghPr(host, 'https://example.com/pull/7; echo') } catch (error) { caught = error }
  expect(caught instanceof CliError).toBe(true)
  expect(calls.length).toBe(1)
})

test('with jq present, exports are shrunk through a pipe whose parts are all positional arguments', async () => {
  const { host, calls } = world(() => ok('{"id":"x"}'), { has: path => path === '/usr/bin/jq' || path === '/Users/test/.local/bin/amp' })
  expect(await ampExport(host, ID)).toBe('{"id":"x"}')
  const argv = calls[0]!.argv
  expect(argv.slice(0, 2)).toEqual(['/bin/bash', '-c'])
  expect(argv[2]).toBe('set -o pipefail; "$1" threads export "$2" | /usr/bin/jq -c "$3"')
  expect(argv.slice(3)).toEqual(['bash', '/Users/test/.local/bin/amp', ID, EXPORT_FILTER])
  expect(argv[2]!.includes(ID) || argv[2]!.includes(EXPORT_FILTER)).toBe(false)
  expect(calls[0]!.timeoutMs).toBe(60_000)
  expect(EXPORT_FILTER.includes('\n')).toBe(false)
})

test('without jq, exports are the plain amp threads export', async () => {
  const { host, calls } = world(() => ok('{"id":"x"}'))
  expect(await ampExport(host, ID)).toBe('{"id":"x"}')
  expect(calls[0]!.argv).toEqual(['amp', 'threads', 'export', ID])
  expect(calls[0]!.timeoutMs).toBe(60_000)
})

test('a failing export pipe reports amp\'s own first stderr line', async () => {
  const { host } = world(() => fail('Error: thread not found\n'), { has: path => path === '/usr/bin/jq' })
  let caught: unknown
  try { await ampExport(host, ID) } catch (error) { caught = error }
  expect((caught as Error).message).toBe('Error: thread not found')
})

test('output cut at the 4 MiB cap is an error, not a half-read JSON document', async () => {
  const { host } = world(() => ({ exitCode: 0, stdout: '{"id":"T-', stderr: '', isStdoutTruncated: true }))
  let caught: unknown
  try { await ampExport(host, ID) } catch (error) { caught = error }
  expect(caught instanceof CliError).toBe(true)
  expect((caught as Error).message).toBe('amp threads export output was cut at 4 MiB')
})

const START = { title: 't', prompt: 'p', project: 'acme/acme-api', mode: 'ultra', size: 'a1.small' }
const caughtBy = async (run: () => Promise<unknown>) => {
  try {
    await run()
  } catch (error) {
    return error
  }

  return undefined
}

test('ampStart finds the thread URL on stderr when stdout has none, and prefers stdout', async () => {
  const other = 'T-0f0e0d0c-0002-7000-8000-000000000002'
  const { host } = world(() => ({ exitCode: 0, stdout: '', stderr: `Started https://ampcode.com/threads/${ID}\n`, isStdoutTruncated: false }))
  expect((await ampStart(host, START)).id).toBe(ID)
  const both = world(() => ({ exitCode: 0, stdout: `https://ampcode.com/threads/${ID}`, stderr: `https://ampcode.com/threads/${other}`, isStdoutTruncated: false }))
  expect((await ampStart(both.host, START)).id).toBe(ID)
})

test('ampStart that times out says the orb may have started, not that it failed', async () => {
  const { host } = world(() => Promise.reject(new Error('timed out after 120000ms')) as Promise<never>)
  const caught = await caughtBy(() => ampStart(host, START))
  expect(caught instanceof StartUnsure).toBe(true)
  expect((caught as Error).message).toContain('timed out after 120000ms')
})

test('ampStart that ends without a thread URL says the orb may have started, with any URL it printed', async () => {
  const { host } = world(() => ({ exitCode: 0, stdout: 'Orb booting: https://ampcode.com/threads/T-oops\n', stderr: 'see https://ampcode.com/orbs/x9 too', isStdoutTruncated: false }))
  const caught = await caughtBy(() => ampStart(host, START))
  expect(caught instanceof StartUnsure).toBe(true)
  expect((caught as StartUnsure).urls).toEqual(['https://ampcode.com/threads/T-oops', 'https://ampcode.com/orbs/x9'])
  const failed = world(() => fail('Error: orb quota reached'))
  const quota = await caughtBy(() => ampStart(failed.host, START))
  expect(quota instanceof StartUnsure).toBe(true)
  expect((quota as Error).message).toBe('Error: orb quota reached')
})
