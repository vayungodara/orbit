import { expect, test } from 'claude-code/testing'

import { stepOf } from '../hooks/steps'

const done = (id: string, isOk = true) => new Map([[id, isOk]])

test('shell commands are classified the way skyline classifies them', async () => {
  expect(stepOf('shell_command', { command: 'cargo test -p api-core' }, 'TU-1', done('TU-1')).category).toBe('test')
  expect(stepOf('shell_command', { command: 'git push origin HEAD' }, 'TU-2', done('TU-2')).category).toBe('git')
  expect(stepOf('shell_command', { command: 'gh pr create --fill' }, 'TU-3', done('TU-3')).category).toBe('github')
})

test('Amp tools map to activities with a short target', async () => {
  const patch = stepOf('apply_patch', { patch: '*** Begin Patch\n*** Update File: crates/api-core/src/scheduler.rs\n@@' }, 'TU-4', done('TU-4'))
  expect(patch.category).toBe('edit')
  expect(patch.target).toBe('scheduler.rs')
  expect(stepOf('finder', { query: 'usage_retry_after' }, 'TU-5', done('TU-5')).category).toBe('search')
  expect(stepOf('Task', { description: 'review the diff' }, 'TU-6', done('TU-6')).category).toBe('agents')
})

test('a step without a result is running, and a failed result is marked', async () => {
  const running = stepOf('shell_command', { command: 'cargo build' }, 'TU-7', new Map())
  expect(running.isRunning).toBe(true)
  const failed = stepOf('shell_command', { command: 'cargo build' }, 'TU-8', done('TU-8', false))
  expect(failed.isRunning).toBe(false)
  expect(failed.isOk).toBe(false)
})

test('an unknown tool still gets an activity, named after the tool', async () => {
  const step = stepOf('mystery_tool', {}, 'TU-9', done('TU-9'))
  expect(step.category).toBe('shell')
  expect(step.target).toBe('mystery_tool')
})

test('targets are clipped to 32 characters', async () => {
  const step = stepOf('finder', { query: 'x'.repeat(80) }, 'TU-10', done('TU-10'))
  expect([...step.target].length).toBeLessThanOrEqual(32)
})
