import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 3, 4)
// the 5-hour window resets 2h13m from now; the band writes that moment in the machine's own zone
const RESET_5H = NOW + (2 * 60 + 13) * 60_000
const hhmm = (ms: number) => [new Date(ms).getHours(), new Date(ms).getMinutes()].map(n => String(n).padStart(2, '0')).join(':')
const TOOL = 'mcp__progress-band__plan_progress'
const START = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const
const BAND = {
  plugin: 'progress-band',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 110, scroll: { offset: 0, bodyRows: 16 }, view: {} },
} as const

// the stub registrar a test function receives as its second argument
type On = Parameters<typeof mock.clock>[0]

function stubSession(on: On, saved: Map<string, unknown>) {
  on('session.id', () => ({ value: 'one' }))
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__progress-band__${e.name}` } }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { tokens: 40_000, window: 200_000, percent: 20 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 62, resetsAt: new Date(RESET_5H).toISOString() },
        { kind: 'seven_day', percentUsed: 5, resetsAt: new Date(NOW + (4 * 24 + 18) * 3_600_000).toISOString() },
      ],
    },
  }))
  on('store.keys', () => ({ value: [...saved.keys()] }))
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    saved.delete(e.key)
    return { value: undefined }
  })
  // what the mods beneath this one draw in the band
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['beneath'] }))
}

const STAGES = [
  { name: '调研', steps: [{ title: '路由' }, { title: '服务' }] },
  { name: '实现', steps: [{ title: '接口' }] },
]

test('a plan moves by short ops, keeps finished steps by title when replanned, and refuses unknown steps', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  stubSession(on, saved)
  await $.session.start(START)

  expect(await $.tool.call({ tool: TOOL, id: 'api', title: 'API 重构', stages: STAGES })).toMatchObject({ result: 'api: 0/3, running, active "路由"' })
  expect(await $.tool.call({ tool: TOOL, id: 'api', next: true })).toMatchObject({ result: 'api: 1/3, running, active "服务"' })
  // a stage lands mid-run; 路由 stays done although it is resent without a status
  const replanned = [STAGES[0], { name: '加固', steps: [{ title: '限流' }] }, STAGES[1]]
  expect(await $.tool.call({ tool: TOOL, id: 'api', stages: replanned })).toMatchObject({ result: 'api: 1/4, running, active "服务"' })
  expect(await $.tool.call({ tool: TOOL, id: 'api', done: ['不存在'] })).toMatchObject({ deny: expect.stringContaining('has no step "不存在"') })
  expect(await $.tool.call({ tool: TOOL, id: 'api', failed: '限流', note: '测试失败' })).toMatchObject({ result: expect.stringContaining('error') })
  expect(await $.tool.call({ tool: TOOL, id: 'api', state: 'done' })).toMatchObject({ result: 'api: 4/4, done' })
  // kept per session, without agents
  expect(saved.get('plans:one')).toMatchObject([{ id: 'api', title: 'API 重构', state: 'done', agents: [] }])
})

test('the band shows the meters, the bar and its agent on the terminal and the desktop', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubSession(on, new Map())
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5-20251001', agentId: 'ag1' }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* () {
    return {
      turnId: 't1',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { input_tokens: 1200, output_tokens: 900_000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 50_000, model: 'claude-opus-5-5' },
    }
  })
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, id: 'ui', title: '界面', stages: [{ name: '构建', steps: [{ title: 'A' }, { title: 'B' }] }] })
  await $.tool.call({ tool: TOOL, id: 'ui', next: true })
  await $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'look around',
    description: '扫描组件',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })

  // one model request ends: its tokens land after the weekly meter at once, in K, M or B
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const chunk of step) void chunk

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'bar-ui' })).toBeDefined()
    expect(await ui.find({ key: 'close-ui' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'beneath' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '上下文' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
    // this session's tokens and the week's in one item (one session here, so the same figure twice)
    expect(await ui.find({ type: 'Text', text: '953K / 953K tokens' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /50%$/ })).toBeDefined()
    // the session strip: what the main conversation does (nothing here); the model stays out, the model picker shows it
    expect(await ui.find({ type: 'Text', text: '空闲' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeUndefined()
    // one row: what the main conversation does leads the meters; no session cost, no 24-hour histogram
    expect(JSON.stringify(await ui.find({ key: 'meters' }))).toContain('空闲')
    expect(await ui.find({ type: 'Text', text: /近24h|本会话 ≈/ })).toBeUndefined()
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: `2h13m (${hhmm(RESET_5H)})` })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '4d18h' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '构建 2/2 · 0s' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /扫描组件 haiku 4\.5/ })).toBeDefined()
    } else {
      expect(await ui.find({ type: 'Text', text: `↻ 2h13m · ${hhmm(RESET_5H)}` })).toBeDefined()
      // the hover card forces no colour, so the app's theme draws it
      expect(await ui.find({ type: 'Text', text: '本周 token · 本机会话' })).toBeDefined()
      // the Sankey: the four kinds flow into the week, which splits into this session and the others
      const card = JSON.stringify(await ui.find({ key: 'tokens' }))
      expect(card).toContain('输入 1.2K，输出 900K，缓存写 2K，缓存读 50K；本会话 953K，其他会话 0')
      expect(card).not.toContain('"color"')
      expect(await ui.find({ type: 'Text', text: '扫描组件' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'haiku 4.5' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '启动中' })).toBeDefined()
      // an Svg keeps no key in the drawing; the track's alt says what it shows
      const bar = JSON.stringify(await ui.find({ key: 'bar-ui' }))
      expect(bar).toContain('界面：进行中，构建 2/2，50%')
      // live: its agent runs, so light drifts down the pipe in two layers and the pixels sparkle
      expect(bar.match(/class=\\"flow\\"/g)).toHaveLength(2)
      expect(bar).toContain('class=\\"tw')
    }
    await ui.unmount()
  }

  // the agent ends and no turn runs: the work pauses, yet the bar keeps moving, slower: one drift layer,
  // a soft twinkle, and its icon's bars sway instead of standing still
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'a1', agentId: 'ag1', reason: 'answer' })
  const idle = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const paused = JSON.stringify(await idle.find({ key: 'bar-ui' }))
  expect(paused.match(/class=\\"flow\\"/g)).toHaveLength(1)
  expect(paused).toContain('class=\\"ts')
  expect(paused).toContain('class=\\"eq e0 slow\\"')
})

test('a resumed session gets its saved bars back, keeps them past the other sessions, and ✕ closes one', async ($, on) => {
  mock.clock(on, { now: NOW })
  const old = {
    id: 'old',
    title: '旧任务',
    stages: [{ name: 'S', steps: [{ title: 'x', status: 'done', doneAt: NOW - 1000 }, { title: 'y', status: 'active' }] }],
    state: 'running',
    note: null,
    startedAt: NOW - 60_000,
    endedAt: null,
    agents: [],
  }
  // this session saved first, 25 sessions after it
  const saved = new Map<string, unknown>([['plans:one', [old]]])
  for (let i = 0; i < 25; i++) saved.set(`plans:other${i}`, [old])
  stubSession(on, saved)
  await $.session.start(START)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'bar-old' })).toBeDefined()
  // a save trims the other sessions to the newest 19 and never this session's own bars
  await $.tool.call({ tool: TOOL, id: 'new', title: '新任务', stages: [{ name: 'S', steps: [{ title: 'z' }] }] })
  expect(saved.has('plans:one')).toBe(true)
  expect([...saved.keys()].filter(k => k.startsWith('plans:'))).toHaveLength(20)
  await ui.press({ key: 'close-old' })
  expect(await ui.find({ key: 'bar-old' })).toBeUndefined()
  expect(saved.get('plans:one')).toMatchObject([{ id: 'new' }])
})

test('the strip says what the main conversation does and never freezes: dancing while it works, swaying while idle', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubSession(on, new Map())
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  // the bottom answers the main conversation's Read; while it runs, the strip names it
  let during = ''
  on('tool.call', async () => {
    during = (await strip()).texts
    return { result: 'ok' }
  })
  await $.session.start(START)

  const strip = async (isWorking = false) => {
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, isWorking } })
    const pulse = JSON.stringify(await ui.find({ key: 'doing' }))
    const texts = (await ui.findAll({ type: 'Text' })).map(x => x.text).join(' ')
    await ui.unmount()
    return { pulse, texts }
  }
  const idle = await strip()
  expect(idle.texts).toContain('空闲')
  expect(idle.pulse).toContain('class=\\"eq e0 slow\\"')
  await $.turn.start({ text: 'go', turnId: 't1' })
  const thinking = await strip(true)
  expect(thinking.texts).toContain('思考中')
  expect(thinking.pulse).toContain('class=\\"eq e0\\"')
  await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
  expect(during).toContain('Read')
  await $.turn.complete({ answer: 'done', durationMs: 83_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect((await strip()).texts).toContain('空闲')
})

test('past the 5-hour alert line the open bar flashes and the meters say so, while Claude works on untold', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubSession(on, new Map())
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('tool.call', () => ({ result: 'ok' }))
  on('classic.Stop', () => ({}))
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, id: 'job', title: '任务', stages: [{ name: 'S', steps: [{ title: 'A' }, { title: 'B' }] }] })
  await $.tool.call({ tool: TOOL, id: 'finished', title: '已完成任务', stages: [{ name: 'S', steps: [{ title: 'A' }] }], state: 'done' })
  const resetsAt = NOW + 60_000
  const measure = (percentUsed: number) =>
    $.session.measure({ changed: ['rateLimits'], context: { tokens: 1, window: 2, percent: 20 }, rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt: new Date(resetsAt).toISOString() }] })
  const look = async (surface: 'terminal' | 'desktop') => {
    const ui = await $.ui.mount({ ...BAND, surface })
    const alert = JSON.stringify((await ui.find({ key: 'quota' })) ?? null)
    const bar = JSON.stringify(await ui.find({ key: 'bar-job' }))
    const finished = JSON.stringify(await ui.find({ key: 'bar-finished' }))
    await ui.unmount()
    return { alert, bar, finished }
  }

  await measure(84)
  for (const surface of ['terminal', 'desktop'] as const) expect((await look(surface)).alert).toBe('null')
  expect((await look('desktop')).bar).not.toContain('class=\\"qa\\"')

  await measure(85)
  await $.turn.start({ text: 'go', turnId: 't1' })
  // Claude reads nothing of it: the tool result comes back as the tool gave it
  const ran = await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
  expect(ran).toMatchObject({ result: 'ok' })
  expect(JSON.stringify(ran)).not.toContain('progress-band')
  for (const surface of ['terminal', 'desktop'] as const) expect((await look(surface)).alert).toContain('额度超过阈值')
  // on the desktop both blink by themselves: a red ring over the bar, a red pill by the 5-hour meter
  const desk = await look('desktop')
  expect(desk.bar).toContain('class=\\"qa\\"')
  expect(desk.alert).toContain('class=\\"qa\\"')
  expect(desk.finished).toBeDefined()
  expect(desk.finished).not.toContain('class=\\"qa\\"')
  // the turn ends and nothing waits for the person: the bar keeps running
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'ok' })
  expect((await look('desktop')).bar).toContain('任务：进行中')
  // an expired reading must clear the alert even before a new usage measurement arrives
  await clock.advance(resetsAt - NOW)
  for (const surface of ['terminal', 'desktop'] as const) expect((await look(surface)).alert).toBe('null')
  expect((await look('desktop')).bar).not.toContain('class=\\"qa\\"')
})

test('with language en the band says all of it in English', { options: { language: 'en' } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  stubSession(on, new Map())
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5-20251001', agentId: 'ag1' }))
  on('turn.step', async function* () {
    return {
      turnId: 't1',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { input_tokens: 1200, output_tokens: 900_000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 50_000, model: 'claude-opus-5-5' },
    }
  })
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, id: 'ui', title: 'Interface', stages: [{ name: 'Build', steps: [{ title: 'A' }, { title: 'B' }] }, { name: 'Ship', steps: [{ title: 'C' }] }] })
  await $.tool.call({ tool: TOOL, id: 'ui', next: true })
  await $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'look around',
    description: 'Scan parts',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) void chunk
  await $.session.measure({
    changed: ['rateLimits'],
    context: { tokens: 1, window: 2, percent: 20 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 90, resetsAt: new Date(RESET_5H).toISOString() },
      { kind: 'seven_day', percentUsed: 5, resetsAt: new Date(NOW + 3 * 24 * 3_600_000).toISOString() },
    ],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const drawn = JSON.stringify(await ui.drawn())
    // no Chinese anywhere: words, alt texts and drawings alike
    expect(drawn).not.toMatch(/[　-鿿＀-￯]/)
    for (const words of ['Idle', 'Context', '5-hour', 'Weekly', 'Quota over threshold', 'starting']) expect(drawn).toContain(words)
    if (surface === 'desktop') {
      for (const words of ['Session / week tokens · this machine', 'Interface: running, Build 2/2, 33%', 'Build stage', 'not reached', 'cache write', 'other sessions']) {
        expect(drawn).toContain(words)
      }
    }
    await ui.unmount()
  }
})
