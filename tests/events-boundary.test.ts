import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 3, 4)
const TOOL = 'mcp__progress-band__plan_progress'
const START = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const
const BAND = {
  plugin: 'progress-band', component: 'AbovePrompt', requestId: 'events-band', surface: 'terminal',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 110, scroll: { offset: 0, bodyRows: 16 }, view: {} },
} as const
const LIMITS = [
  { kind: 'five_hour', percentUsed: 62, resetsAt: new Date(NOW + 2 * 3_600_000).toISOString() },
  { kind: 'seven_day', percentUsed: 5, resetsAt: new Date(NOW + 4 * 24 * 3_600_000).toISOString() },
]
type On = Parameters<typeof mock.clock>[0]
const copy = (value: unknown) => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

function stubSession(on: On, saved: Map<string, unknown>, get?: (key: string, value: unknown) => Promise<unknown>, limits = LIMITS) {
  on('session.id', () => ({ value: 'events-one' }))
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__progress-band__${e.name}` } }))
  on('session.usage', () => ({ value: {
    startedAt: NOW,
    context: { tokens: 40_000, window: 200_000, percent: 20 },
    rateLimits: limits,
  } }))
  on('store.keys', () => ({ value: [...saved.keys()] }))
  on('store.get', async ($, e) => {
    const value = copy(saved.get(e.key))
    return { value: get ? await get(e.key, value) : value }
  })
  on('store.set', ($, e) => {
    saved.set(e.key, copy(e.value))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    saved.delete(e.key)
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['beneath'] }))
}

test('an agent follows the most recently updated open plan', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubSession(on, new Map())
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5-20251001', agentId: 'focus-agent' }))
  await $.session.start(START)
  const stages = [{ name: 'S', steps: [{ title: 'A' }, { title: 'B' }] }]
  await $.tool.call({ tool: TOOL, id: 'first', title: 'First', stages })
  await clock.advance(1)
  await $.tool.call({ tool: TOOL, id: 'second', title: 'Second', stages })
  await clock.advance(1)
  await $.tool.call({ tool: TOOL, id: 'first', next: true })
  await $.agent.spawn({
    tool_use_id: 'focus-spawn', prompt: 'Inspect the first task', description: 'Inspect',
    subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5', background: true, fork: false,
  })
  const ui = await $.ui.mount(BAND)
  expect(JSON.stringify(await ui.find({ key: 'bar-first' }))).toContain('agent-focus-agent')
  expect(JSON.stringify(await ui.find({ key: 'bar-second' }))).not.toContain('agent-focus-agent')
})

test('startup uses current session limits when a shared reading expired', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>([['limits', {
    at: NOW - 7 * 24 * 3_600_000,
    limits: [
      { kind: 'five_hour', percentUsed: 99, resetsAt: new Date(NOW - 3_600_000).toISOString() },
      { kind: 'seven_day', percentUsed: 99, resetsAt: new Date(NOW - 24 * 3_600_000).toISOString() },
    ],
  }]])
  stubSession(on, saved)
  await $.session.start(START)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '5%' })).toBeDefined()
})

test('startup keeps current shared limits when the session last reported expired windows', async ($, on) => {
  mock.clock(on, { now: NOW })
  const expired = LIMITS.map(limit => ({ ...limit, percentUsed: 99, resetsAt: new Date(NOW - 3_600_000).toISOString() }))
  const saved = new Map<string, unknown>([['limits', { at: NOW - 1000, limits: LIMITS }]])
  stubSession(on, saved, undefined, expired)
  await $.session.start(START)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '5%' })).toBeDefined()
})

test('a shared limit refresh cannot replace a newer local measurement', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  let pauseRead = false
  let reachedRead!: () => void
  let releaseRead!: () => void
  const reached = new Promise<void>(resolve => { reachedRead = resolve })
  const released = new Promise<void>(resolve => { releaseRead = resolve })
  stubSession(on, saved, async (key, value) => {
    if (pauseRead && key === 'limits') {
      pauseRead = false
      reachedRead()
      await released
    }
    return value
  })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.start(START)
  const older = LIMITS.map(limit => ({ ...limit, percentUsed: 70 }))
  saved.set('limits', { at: NOW + 30_000, limits: older })
  pauseRead = true
  const refresh = clock.advance(60_000)
  await reached
  const newer = LIMITS.map(limit => ({ ...limit, percentUsed: 80 }))
  await $.session.measure({ changed: ['rateLimits'], context: { tokens: 40_000, window: 200_000, percent: 20 }, rateLimits: newer })
  releaseRead()
  await refresh
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: '80%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '70%' })).toBeUndefined()
})

test('a weekly recount cannot overwrite a request that completed while it read storage', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  let pauseRead = false
  let reachedRead!: () => void
  let releaseRead!: () => void
  const reached = new Promise<void>(resolve => { reachedRead = resolve })
  const released = new Promise<void>(resolve => { releaseRead = resolve })
  stubSession(on, saved, async (key, value) => {
    if (pauseRead && key === 'tok:events-one') {
      pauseRead = false
      reachedRead()
      await released
    }
    return value
  })
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: e.model },
    }
  })
  await $.session.start(START)
  for await (const chunk of $.turn.step({ turnId: 'before-recount', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) void chunk
  await clock.settle()
  pauseRead = true
  const refresh = clock.advance(60_000)
  await reached
  const request = (async () => {
    for await (const chunk of $.turn.step({ turnId: 'during-recount', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) void chunk
  })()
  await clock.settle()
  releaseRead()
  await refresh
  await request
  await clock.settle()
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: '/ 200 tokens' })).toBeDefined()
})

test('invalid persisted token buckets cannot corrupt the weekly total', async ($, on) => {
  mock.clock(on, { now: NOW })
  const hour = String(NOW)
  const saved = new Map<string, unknown>([
    ['tok:valid', { [hour]: [100, 20, 3, 4] }],
    ['tok:invalid', { [hour]: ['bad', -10, null, {}] }],
  ])
  stubSession(on, saved)
  await $.session.start(START)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: '/ 127 tokens' })).toBeDefined()
})
