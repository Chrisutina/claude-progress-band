import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 3, 4)
const TOOL = 'mcp__progress-band__plan_progress'
const START = { surface: 'desktop', isInteractive: true, cwd: '/work' } as const
const BAND = {
  plugin: 'progress-band', component: 'AbovePrompt', requestId: 'render-boundary',
  surface: 'desktop', viewport: { columns: 40, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 40, scroll: { offset: 0, bodyRows: 16 }, view: {} },
} as const
type On = Parameters<typeof mock.clock>[0]

function stub(on: On, saved = new Map<string, unknown>()) {
  on('session.id', () => ({ value: 'render' }))
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__progress-band__${e.name}` } }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { tokens: 0, window: 200_000, percent: 0 }, rateLimits: [] } }))
  on('store.keys', () => ({ value: [...saved.keys()] }))
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => { saved.set(e.key, e.value); return { value: undefined } })
  on('store.delete', ($, e) => { saved.delete(e.key); return { value: undefined } })
  on('ui.render', () => ({ type: 'Text', props: {}, children: [] }))
  return saved
}

function svgSources(node: unknown): string[] {
  if (!node || typeof node !== 'object') return []
  const value = node as Record<string, unknown>
  return Object.entries(value).flatMap(([key, item]) => key === 'source' && typeof item === 'string' && item.startsWith('<svg') ? [item] : svgSources(item))
}

test('SVG text excludes illegal XML characters and preserves valid Unicode at title limits', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved = stub(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, id: 'unicode', title: `${'A'.repeat(79)}😀`, stages: [{ name: '\0阶段\uffff & < > "', steps: [{ title: '\u0001步骤\ud800' }, { title: '第二步' }] }] })
  const ui = await $.ui.mount(BAND)
  const sources = svgSources(await ui.find({ key: 'bar-unicode' }))
  expect(sources.length).toBeGreaterThan(0)
  for (const source of sources) {
    expect(source).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/)
    expect(source).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  }
  const plan = (saved.get('plans:render') as { title: string }[])[0]!
  expect(plan.title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  await ui.unmount()
})

test('checkpoint tooltips fit a narrow track and retain their complete labels', async ($, on) => {
  mock.clock(on, { now: NOW })
  stub(on)
  await $.session.start(START)
  const title = '界'.repeat(120)
  await $.tool.call({ tool: TOOL, id: 'narrow', title: '窄窗口', stages: [{ name: 'S', steps: [{ title }, { title: 'B' }] }] })
  const ui = await $.ui.mount(BAND)
  const sources = svgSources(await ui.find({ key: 'bar-narrow' }))
  const overlay = sources.find(source => source.includes('class="tp p1"'))!
  expect(overlay).toBeDefined()
  const width = Number(overlay.match(/<svg[^>]+width="([\d.]+)"/)?.[1])
  const rect = overlay.match(/<g class="tp p1">(?:<title>[\s\S]*?<\/title>)?<rect x="([\d.]+)"[^>]+width="([\d.]+)"/)
  expect(rect).toBeDefined()
  expect(Number(rect![1]) + Number(rect![2])).toBeLessThanOrEqual(width)
  expect(overlay).toContain(`<title>${title}`)
  await ui.unmount()
})

test('a live clock past 99 minutes displays its real duration instead of wrapping', async ($, on) => {
  mock.clock(on, { now: NOW })
  stub(on, new Map([['plans:render', [{ id: 'long', title: '长任务', stages: [{ name: 'S', steps: [{ title: 'A', status: 'active' }, { title: 'B', status: 'pending' }] }], state: 'running', note: null, startedAt: NOW - 100 * 60_000, endedAt: null, agents: [] }]]]))
  await $.session.start(START)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 110 } })
  const overlay = svgSources(await ui.find({ key: 'bar-long' })).find(source => source.includes('clockFallback'))!
  expect(overlay).toContain('1h 40m')
  expect(overlay).toContain('.clockReels{display:none}')
  expect(overlay).toContain('.clockFallback{display:inline}')
  await ui.unmount()
})

test('agent fallback time refreshes with the minute timer and reduced motion has a still clock', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stub(on)
  on('agent.spawn', () => ({ model: 'model', agentId: 'ag-clock' }))
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, id: 'clock', title: '计时', stages: [{ name: 'S', steps: [{ title: 'A' }] }] })
  await $.agent.spawn({ tool_use_id: 'spawn-clock', prompt: 'inspect', description: '调查', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'model', background: false, fork: false })
  const ui = await $.ui.mount(BAND)
  const before = svgSources(await ui.find({ key: 'agent-ag-clock' })).find(source => source.includes('clockFallback'))!
  expect(before).toContain('prefers-reduced-motion:reduce')
  await clock.advance(60_000)
  const after = svgSources(await ui.find({ key: 'agent-ag-clock' })).find(source => source.includes('clockFallback'))!
  expect(after).not.toBe(before)
  expect(after).toContain('>1m 0s</text>')
  await ui.unmount()
})
