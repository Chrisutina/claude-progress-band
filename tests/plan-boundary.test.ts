import { expect, mock, test } from 'claude-code/testing'
import type { Plan } from '../types'

const NOW = Date.UTC(2026, 9, 3, 4)
const TOOL = 'mcp__progress-band__plan_progress'
const START = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const
const BAND = {
  plugin: 'progress-band',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  surface: 'desktop',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 110, scroll: { offset: 0, bodyRows: 16 }, view: {} },
} as const
type On = Parameters<typeof mock.clock>[0]

function stubSession(on: On, saved: Map<string, unknown>, beforeSet?: (key: string, value: unknown) => Promise<void>) {
  const clock = mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'one' }))
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__progress-band__${e.name}` } }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { tokens: 0, window: 200_000, percent: 0 }, rateLimits: [] } }))
  on('store.keys', () => ({ value: [...saved.keys()] }))
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', async ($, e) => {
    if (beforeSet) await beforeSet(e.key, e.value)
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    saved.delete(e.key)
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['beneath'] }))
  return clock
}

const stages = (...titles: string[]) => [{ name: 'S', steps: titles.map(title => ({ title })) }]
const stored = (saved: Map<string, unknown>, id: string) => (saved.get('plans:one') as Plan[]).find(p => p.id === id)!

test('replanning duplicate titles consumes each finished occurrence once', async ($, on) => {
  const saved = new Map<string, unknown>()
  stubSession(on, saved)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, id: 'duplicate', stages: stages('检查', '检查') })
  await $.tool.call({ tool: TOOL, id: 'duplicate', done: ['检查'] })
  expect(await $.tool.call({ tool: TOOL, id: 'duplicate', stages: stages('检查', '检查') })).toMatchObject({ result: 'duplicate: 1/2, running, active "检查"' })
  expect(stored(saved, 'duplicate').stages[0]!.steps.map(s => s.status)).toEqual(['done', 'active'])
})

for (const state of ['error', 'needs_input', 'done'] as const) {
  test(`a note-only update preserves ${state}`, async ($, on) => {
    const saved = new Map<string, unknown>()
    stubSession(on, saved)
    await $.session.start(START)
    const id = state.replace('_', '-')
    await $.tool.call({ tool: TOOL, id, stages: stages('A', 'B') })
    await $.tool.call({ tool: TOOL, id, state, ...(state === 'error' ? { failed: 'A' } : {}), note: '原说明' })
    await $.tool.call({ tool: TOOL, id, note: '补充说明' })
    expect(stored(saved, id).state).toBe(state)
    expect(stored(saved, id).note).toBe('补充说明')
    if (state === 'done') expect(stored(saved, id).endedAt).toBe(NOW)
  })
}

test('advancing a different step keeps remaining failures visible', async ($, on) => {
  const saved = new Map<string, unknown>()
  stubSession(on, saved)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, id: 'failure', state: 'error', stages: [{ name: 'S', steps: [{ title: 'A', status: 'active' }, { title: 'B', status: 'error' }, { title: 'C' }] }] })
  await $.tool.call({ tool: TOOL, id: 'failure', next: true })
  expect(stored(saved, 'failure').state).toBe('error')
  expect(stored(saved, 'failure').stages[0]!.steps.map(s => s.status)).toEqual(['done', 'error', 'active'])
})

for (const op of ['active', 'failed'] as const) {
  test(`marking a finished step ${op} clears its old completion timestamp`, async ($, on) => {
    const saved = new Map<string, unknown>()
    stubSession(on, saved)
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, id: 'timestamp', stages: stages('A', 'B') })
    await $.tool.call({ tool: TOOL, id: 'timestamp', next: true })
    expect(stored(saved, 'timestamp').stages[0]!.steps[0]!.doneAt).toBe(NOW)
    await $.tool.call({ tool: TOOL, id: 'timestamp', [op]: 'A' })
    expect(stored(saved, 'timestamp').stages[0]!.steps[0]!.doneAt).toBeUndefined()
  })
}

test('short operations use the same title normalization as creation', async ($, on) => {
  const saved = new Map<string, unknown>()
  stubSession(on, saved)
  await $.session.start(START)
  for (const [id, title] of [['spaces', ' A  B '], ['long', 'x'.repeat(121)]] as const) {
    await $.tool.call({ tool: TOOL, id, stages: stages(title) })
    expect(await $.tool.call({ tool: TOOL, id, done: [title] })).toMatchObject({ result: `${id}: 1/1, done` })
  }
})

test('restoring malformed saved entries keeps valid bars usable', async ($, on) => {
  const good: Plan = { id: 'good', title: '有效计划', stages: [{ name: 'S', steps: [{ title: 'A', status: 'active' }] }], state: 'running', note: null, startedAt: NOW, endedAt: null, agents: [] }
  const saved = new Map<string, unknown>([['plans:one', [null, { ...good, id: 'bad-state', state: 'alien' }, { ...good, id: 'bad-stage', stages: [null] }, good]]])
  stubSession(on, saved)
  await $.session.start(START)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'bar-good' })).toBeDefined()
  expect(await ui.find({ key: 'bar-bad-state' })).toBeUndefined()
  expect(await ui.find({ key: 'bar-bad-stage' })).toBeUndefined()
  await ui.unmount()
  expect(await $.tool.call({ tool: TOOL, id: 'good', next: true })).toMatchObject({ result: 'good: 1/1, done' })
})

test('unknown ids and mixed known/unknown operations are refused atomically', async ($, on) => {
  const saved = new Map<string, unknown>()
  stubSession(on, saved)
  await $.session.start(START)
  expect(await $.tool.call({ tool: TOOL, id: 'missing', next: true })).toMatchObject({ deny: expect.stringContaining('no bar "missing" yet') })
  expect(saved.has('plans:one')).toBe(false)
  await $.tool.call({ tool: TOOL, id: 'atomic', stages: stages('A', 'B') })
  const before = JSON.stringify(saved.get('plans:one'))
  expect(await $.tool.call({ tool: TOOL, id: 'atomic', done: ['A', 'unknown'] })).toMatchObject({ deny: expect.stringContaining('has no step "unknown"') })
  expect(JSON.stringify(saved.get('plans:one'))).toBe(before)
})

test('concurrent saves cannot persist an older plan after a newer update', async ($, on) => {
  const saved = new Map<string, unknown>()
  let firstWrite = true
  let reachedFirst!: () => void
  let releaseFirst!: () => void
  const reached = new Promise<void>(resolve => { reachedFirst = resolve })
  const released = new Promise<void>(resolve => { releaseFirst = resolve })
  const clock = stubSession(on, saved, async key => {
    if (key === 'plans:one' && firstWrite) {
      firstWrite = false
      reachedFirst()
      await released
    }
  })
  await $.session.start(START)
  const create = $.tool.call({ tool: TOOL, id: 'race', stages: stages('A', 'B') })
  await reached
  const advance = $.tool.call({ tool: TOOL, id: 'race', next: true })
  // Let the second call update the atom while the first write is held. A fixed
  // save queue holds its persistence too, so release before awaiting the call.
  await clock.settle()
  releaseFirst()
  await Promise.all([create, advance])
  expect(stored(saved, 'race').stages[0]!.steps.map(s => s.status)).toEqual(['done', 'active'])
})
