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
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 16, bodyColumns: 110, scroll: { offset: 0, bodyRows: 16 }, view: {} },
} as const

// the stub registrar a test function receives as its second argument
type On = Parameters<typeof mock.clock>[0]

function stubSession(on: On, saved: Map<string, unknown>, id = () => 'one') {
  on('session.id', () => ({ value: id() }))
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
    // a desktop band wide enough that its meters' row keeps every reset
    const ui = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, bodyColumns: surface === 'desktop' ? 160 : BAND.props.bodyColumns } })
    expect(await ui.find({ key: 'bar-ui' })).toBeDefined()
    expect(await ui.find({ key: 'close-ui' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'beneath' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '上下文' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
    // this session's tokens and the week's in one item (one session here, so the same figure twice)
    expect(await ui.find({ type: 'Text', text: '953K / 953K tokens' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /50%$/ })).toBeDefined()
    // the model stays out, the model picker shows it; no session cost, no 24-hour histogram
    expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /近24h|本会话 ≈/ })).toBeUndefined()
    if (surface === 'terminal') {
      // what the main conversation does (nothing here) leads the meters
      expect(await ui.find({ type: 'Text', text: '空闲' })).toBeDefined()
      expect(JSON.stringify(await ui.find({ key: 'meters' }))).toContain('空闲')
      expect(await ui.find({ type: 'Text', text: `2h13m (${hhmm(RESET_5H)})` })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '4d18h' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '构建 2/2 · 0s' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /扫描组件 haiku 4\.5/ })).toBeDefined()
    } else {
      // this session's cache hit rate leads the meters instead: 50K of the 53.2K it read came from the cache;
      // hovering it shows the split and the main conversation's last request
      expect((await ui.find({ key: 'meters' }))?.text).toMatch(/^缓存94%/)
      expect(await ui.find({ type: 'Text', text: '空闲' })).toBeUndefined()
      const cache = await ui.find({ key: 'cache' })
      expect(cache?.text).toContain('本会话缓存命中率 94%')
      expect(cache?.text).toContain('读缓存 50K · 写缓存 2K · 未缓存 1.2K')
      expect(cache?.text).toContain('最近一次请求 94%')
      expect(JSON.stringify(cache)).toContain('"color":"#57BB78"')
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
      // live: its agent runs, so the aurora streams in its three layers at full speed and the atom's electrons race
      expect(bar.match(/class=\\"flow\\"/g)).toHaveLength(3)
      expect(bar).toContain('pau0 14.62s')
      expect(bar).toContain('animation-duration:0.80s')
    }
    await ui.unmount()
  }

  // the agent ends and no turn runs: the work pauses, yet the bar keeps moving at half speed, and its atom's
  // electrons circle slowly instead of standing still
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'a1', agentId: 'ag1', reason: 'answer' })
  const idle = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const paused = JSON.stringify(await idle.find({ key: 'bar-ui' }))
  expect(paused.match(/class=\\"flow\\"/g)).toHaveLength(3)
  expect(paused).toContain('pau0 29.23s')
  expect(paused).toContain('animation-duration:2.29s')
  expect(paused).not.toContain('animation-duration:0.80s')
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

test('the terminal strip says what the main conversation does; the desktop leads with the cache hit rate, whatever runs', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubSession(on, new Map())
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const strip = async (surface: 'terminal' | 'desktop', isWorking = false) => {
    const ui = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, isWorking } })
    const text = (await ui.find({ key: 'meters' }))?.text ?? ''
    await ui.unmount()
    return text
  }
  // the bottom answers the main conversation's Read; while it runs, the terminal's strip names it
  let during = { terminal: '', desktop: '' }
  on('tool.call', async () => {
    during = { terminal: await strip('terminal'), desktop: await strip('desktop') }
    return { result: 'ok' }
  })
  await $.session.start(START)

  // no request yet: the desktop's cache meter reads — and its card says why
  const empty = await strip('desktop')
  expect(empty).toMatch(/^缓存—本会话还没有请求上下文20%/)
  expect(await strip('terminal')).toMatch(/^○ 空闲/)
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(await strip('terminal', true)).toMatch(/^● 思考中/)
  expect(await strip('desktop', true)).toBe(empty)
  await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
  expect(during.terminal).toMatch(/^● Read/)
  expect(during.desktop).toBe(empty)
  await $.turn.complete({ answer: 'done', durationMs: 83_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await strip('terminal')).toMatch(/^○ 空闲/)
  expect(await strip('desktop')).toBe(empty)
})

test('the cache hit rate counts every request of the session, agents too; hover shows the last main request; /resume shows that session\'s own', async ($, on) => {
  mock.clock(on, { now: NOW })
  const hour = Math.floor(NOW / 3_600_000) * 3_600_000
  // another session of this machine that read nearly all of its input from the cache
  const saved = new Map<string, unknown>([['tok:two', { [hour]: [100, 10, 100, 9800] }]])
  let id = 'one'
  stubSession(on, saved, () => id)
  on('classic.SessionStart', () => ({}))
  // each request answers the next usage in line: [uncached input, cache write, cache read]
  const queue: [number, number, number][] = []
  on('turn.step', async function* ($, e) {
    const [input, write, read] = queue.shift() ?? [0, 0, 0]
    return {
      turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { input_tokens: input, output_tokens: 50, cache_creation_input_tokens: write, cache_read_input_tokens: read, model: 'claude-opus-5-5' },
    }
  })
  const request = async (usage: [number, number, number], agentId?: string) => {
    queue.push(usage)
    for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, ...(agentId ? { agentId } : {}) })) void chunk
  }
  const look = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const cache = await ui.find({ key: 'cache' })
    await ui.unmount()
    return { text: cache?.text ?? '', json: JSON.stringify(cache) }
  }
  await $.session.start(START)

  // the first request writes the cache and reads none of it: red
  await request([1000, 9000, 0])
  let cache = await look()
  expect(cache.text).toMatch(/^缓存0%本会话缓存命中率 0%读缓存 0 · 写缓存 9K · 未缓存 1K最近一次请求 0%$/)
  expect(cache.json).toContain('"color":"#E5534B"')
  // the next reads it all: the session's rate climbs to 30K of 40K, amber, while the last request is whole
  await request([0, 0, 30_000])
  cache = await look()
  expect(cache.text).toContain('缓存75%')
  expect(cache.text).toContain('最近一次请求 100%')
  expect(cache.json).toContain('"color":"#EBAA3C"')
  // an agent's request, all uncached, pulls the session's rate down; the main conversation's last request stays
  await request([20_000, 0, 0], 'ag1')
  cache = await look()
  expect(cache.text).toContain('缓存50%')
  expect(cache.text).toContain('读缓存 30K · 写缓存 9K · 未缓存 21K')
  expect(cache.text).toContain('最近一次请求 100%')

  // /resume to the other session: its own figures at once, and no last request until it makes one
  id = 'two'
  await $.classic.SessionStart({ source: 'resume' })
  cache = await look()
  expect(cache.text).toMatch(/^缓存98%本会话缓存命中率 98%读缓存 9.8K · 写缓存 100 · 未缓存 100$/)
  expect(cache.json).toContain('"color":"#57BB78"')
})

test('a collapsed band still draws but skips the terminal\'s second-by-second redraw, which comes back once it expands', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubSession(on, new Map())
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  let redraws = 0
  on('ui.invalidate', ($, e) => {
    if (e.event === 'ui.render') redraws++
    return { value: undefined }
  })
  await $.session.start(START)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ticks = async () => {
    const before = redraws
    await clock.advance(3000)
    return redraws - before
  }

  // collapsed (ctrl+x ctrl+a or [-] since 2.1.322): the tree still returns, and nothing redraws it each second
  const folded = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: true, isCollapsed: true } })
  expect((await folded.findAll({ type: 'Text' })).map(x => x.text).join('')).toContain('上下文')
  expect(await ticks()).toBe(0)
  await folded.unmount()

  // expanded, a working band ticks again every second
  const open = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: true } })
  expect(await ticks()).toBe(3)
  await open.unmount()
})

test('the desktop meters stay on one line: what has no room drops, and the tool in use changes nothing', async ($, on) => {
  mock.clock(on, { now: NOW })
  const hour = Math.floor(NOW / 3_600_000) * 3_600_000
  stubSession(on, new Map([['tok:one', { [hour]: [1200, 900_000, 2000, 50_000] }]]))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  const row = async (bodyColumns: number) => {
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, isWorking: true, bodyColumns } })
    const meters = await ui.find({ key: 'meters' })
    await ui.unmount()
    return { wrap: meters?.props.flexWrap, text: meters?.text ?? '' }
  }
  let during = { wrap: undefined as unknown, text: '' }
  on('tool.call', async () => {
    during = await row(100)
    return { result: 'ok' }
  })
  await $.session.start(START)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const wide = await row(200)
  const narrow = await row(100)
  // room for all of it: both resets, the 5-hour one with its clock time, and the token words
  expect(wide.wrap).toBe('nowrap')
  expect(wide.text).toContain(`↻ 2h13m · ${hhmm(RESET_5H)}`)
  expect(wide.text).toContain('↻ 4d18h')
  expect(wide.text).toContain('953K / 953K tokens')
  // a narrow band keeps every meter and drops the resets, never wrapping
  expect(narrow.wrap).toBe('nowrap')
  expect(narrow.text).toMatch(/^缓存94%.*上下文20%5小时62%每周5%/)
  expect(narrow.text).not.toContain('↻')
  // the desktop row names no tool, so even a long tool name leaves it as it was
  await $.tool.call({ tool: 'mcp__plugin_semgrep_guardian__get_semgrep_sast_findings' })
  expect(during.wrap).toBe('nowrap')
  expect(during.text).toBe(narrow.text)
})

test('past 90% of the 5-hour window the meter turns into a sign and every 2 more points the open bar glitches WARNING for 6 s, while Claude works on untold', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubSession(on, new Map())
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('tool.call', () => ({ result: 'ok' }))
  on('classic.Stop', () => ({}))
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, id: 'job', title: '任务', stages: [{ name: 'S', steps: [{ title: 'A' }, { title: 'B' }] }] })
  await $.tool.call({ tool: TOOL, id: 'finished', title: '已完成任务', stages: [{ name: 'S', steps: [{ title: 'A' }] }], state: 'done' })
  const resetsAt = NOW + 120_000
  const measure = (percentUsed: number, resets = resetsAt) =>
    $.session.measure({ changed: ['rateLimits'], context: { tokens: 1, window: 2, percent: 20 }, rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt: new Date(resets).toISOString() }] })
  const look = async (surface: 'terminal' | 'desktop') => {
    const ui = await $.ui.mount({ ...BAND, surface })
    const drawn = JSON.stringify(await ui.drawn())
    const bar = JSON.stringify(await ui.find({ key: 'bar-job' }))
    const finished = JSON.stringify(await ui.find({ key: 'bar-finished' }))
    const meter = JSON.stringify(await ui.find({ key: 'meter-five_hour' }))
    await ui.unmount()
    return { drawn, bar, finished, meter }
  }

  // the glitch: the bar a band tearing every 4.8 s, on the terminal WARNING; the meter an amber dot-matrix sign
  const isBand = (drawing: string) => drawing.includes('mix-blend-mode:screen') && drawing.includes('4.8s steps(1,end)')
  const isSign = (drawing: string) => drawing.includes('#FFB020') && drawing.includes('steps(')
  const isGlitching = async () => isBand((await look('desktop')).bar)

  // below the line nothing changes
  await measure(89)
  const before = await look('desktop')
  expect(isBand(before.bar)).toBe(false)
  expect(isSign(before.meter)).toBe(false)
  expect((await look('terminal')).bar).not.toContain('WARNING')

  // at 90% the open bar glitches and the meter turns into the sign; Claude reads nothing of it
  await measure(90)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ran = await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
  expect(ran).toMatchObject({ result: 'ok' })
  expect(JSON.stringify(ran)).not.toContain('progress-band')
  for (const surface of ['terminal', 'desktop'] as const) expect((await look(surface)).drawn).not.toContain('阈值')
  expect((await look('terminal')).bar).toContain('WARNING // WARNING')
  // the band streams WARNING, a 69.5 px run a lap, at half pace with no work on it; a finished bar stays as it was
  const desk = await look('desktop')
  expect(isBand(desk.bar)).toBe(true)
  expect(desk.bar).toContain('psl 6.32s')
  expect(desk.bar).not.toContain('pau0')
  expect(isSign(desk.meter)).toBe(true)
  expect(isBand(desk.finished)).toBe(false)

  // six seconds later the bar is its aurora again while the meter keeps its sign, and one more point changes nothing
  await clock.advance(6000)
  const calm = await look('desktop')
  expect(isBand(calm.bar)).toBe(false)
  expect(calm.bar).toContain('pau0')
  expect(isSign(calm.meter)).toBe(true)
  expect((await look('terminal')).bar).not.toContain('WARNING')
  await measure(91)
  expect(await isGlitching()).toBe(false)
  // two more points glitch it again, for six seconds
  await measure(92)
  expect(await isGlitching()).toBe(true)
  await clock.advance(5000)
  expect(await isGlitching()).toBe(true)
  await clock.advance(1000)
  expect(await isGlitching()).toBe(false)

  // the turn ends and nothing waits for the person: the bar keeps running
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'ok' })
  expect((await look('desktop')).bar).toContain('任务：进行中')
  // an expired reading clears the sign even before a new measurement arrives; the next climb past the line glitches again
  await clock.advance(resetsAt - (NOW + 12_000))
  const after = await look('desktop')
  expect(isBand(after.bar)).toBe(false)
  expect(isSign(after.meter)).toBe(false)
  await measure(90, resetsAt + 5 * 3_600_000)
  expect(await isGlitching()).toBe(true)
})

test('a failed bar turns into a glitch band streaming ERROR, and reads ERROR on the terminal', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubSession(on, new Map())
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, id: 'job', title: '任务', stages: [{ name: 'S', steps: [{ title: 'A' }, { title: 'B' }] }] })
  await $.tool.call({ tool: TOOL, id: 'job', failed: 'A', note: 'boom' })
  const bar = async (surface: 'terminal' | 'desktop') => {
    const ui = await $.ui.mount({ ...BAND, surface })
    const found = JSON.stringify(await ui.find({ key: 'bar-job' }))
    await ui.unmount()
    return found
  }
  // the word in cyan and magenta fringes, tearing every 2.2 s, with no aurora left
  const desk = await bar('desktop')
  expect(desk).toContain('ERROR')
  expect(desk).toContain('mix-blend-mode:screen')
  expect(desk).toContain('2.2s steps(1,end)')
  expect(desk).not.toContain('pau0')
  expect(await bar('terminal')).toContain('ERROR // ERROR')
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
    for (const words of ['Context', '5-hour', 'Weekly', 'starting']) expect(drawn).toContain(words)
    if (surface === 'terminal') expect(drawn).toContain('Idle')
    if (surface === 'desktop') {
      for (const words of ['Cache', 'Session cache hit rate 94%', 'read 50K · written 2K · uncached 1.2K', 'last request 94%', 'Session / week tokens · this machine', 'Interface: running, Build 2/2, 33%', 'Build stage', 'not reached', 'cache write', 'other sessions']) {
        expect(drawn).toContain(words)
      }
    }
    await ui.unmount()
  }
})
