// progress-band: one band above the prompt. Its first row is the usage meters (context, 5-hour and
// weekly limits, the week's tokens); under it, a live progress bar per task with its subagents.
// The plan logic (short ops, replans, agents from engine events) and the reel clock are adapted from
// plan-progress by Kirill Serditov, MIT, https://github.com/zycck/claude-mods (see ../LICENSE).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, RenderChildren } from 'claude-code'

import type { AgentRun, Limit, Plan, PlanStage, PlanState, PlanStep, StepStatus, TokenCounts, Usage } from '../types'

const TOOL = 'mcp__progress-band__plan_progress'
const plans = atom({ plugin: 'progress-band', key: 'plans' } as const, [])
const usage = atom({ plugin: 'progress-band', key: 'usage' } as const, { contextPercent: null, limits: [], at: 0, tokens: null })
// what the main conversation does right now, leading the meters' row, and the tokens this session used. How long
// the turn took and the model it runs on stay out: the app's turn footer and model picker show them
const activity = atom({ plugin: 'progress-band', key: 'activity' } as const, { state: 'idle', tool: null })
const session = atom({ plugin: 'progress-band', key: 'session' } as const, { tokens: 0 })
// the person's stop line: past this share of the 5-hour window, Claude wraps up at a clean point and waits for them
const QUOTA_STOP = 85

const MAX_BARS = 3
const MAX_AGENTS = 30 // kept per bar; the oldest finished go first
// a space as wide as a digit, so '  0%' and '100%' take the same room
const FIGURE_SPACE = String.fromCharCode(0x2007)
// rows hanging under a bar (note, agents, the "+N" row), by how many bars share the band
const childBudget = (bars: number) => (bars >= 3 ? 3 : bars === 2 ? 4 : 5)
const STATUSES: StepStatus[] = ['pending', 'active', 'done', 'error', 'skipped']

const RULES = `# Progress bars
Tasks needing more than ~3 edits or commands get a bar via ${TOOL}: create it once with the full breakdown (2-7 stages of steps {title}, or one stage for a flat list; titles of at most 4 words, in the user's language; the first open step becomes active), then move it with short calls: {id, next:true} when the active step is finished, or {id, done:[...], active:"..."}, {id, failed:"...", note}. When the plan changes, resend stages under the same id; steps sent without a status keep their done by title. Send state "needs_input" with a note before asking the user to decide. Never describe the bars to the user.`

type Raw = Record<string, unknown>
const str = (v: unknown, max = 120) => (typeof v === 'string' ? [...v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffe\uffff]|[\ud800-\udfff]/gu, '').replace(/\s+/g, ' ').trim()].slice(0, max).join('') : '')
const status = (v: unknown): StepStatus => (STATUSES.includes(v as StepStatus) ? (v as StepStatus) : 'pending')
const list = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : []) as Raw[]
const isFinished = (s: StepStatus) => s === 'done' || s === 'skipped'
const same = (a: string, b: string) => str(a).toLowerCase() === str(b).toLowerCase()

// ---------- plans ----------

// short updates: {next:true}, {done:[titles]}, {active:title}, {failed:title} against the stored plan;
// titles it cannot find come back in missing, so the call is refused instead of passing as a success
function applyOps(stages: PlanStage[], input: Raw, now: number): { stages: PlanStage[]; missing: string[] } {
  const next = stages.map(s => ({ ...s, steps: s.steps.map(st => ({ ...st })) }))
  const steps = next.flatMap(s => s.steps)
  const missing: string[] = []
  // a step finishing now remembers when, for the time its checkpoint shows
  const finish = (st: PlanStep) => {
    if (!isFinished(st.status)) Object.assign(st, { status: 'done', doneAt: now })
  }
  // a title used twice means the one still open
  const find = (title: string) => {
    const found = steps.find(st => same(st.title, title) && !isFinished(st.status)) ?? steps.find(st => same(st.title, title))
    if (!found) missing.push(title)
    return found
  }
  if (input.next === true) {
    const activeAt = steps.findIndex(st => st.status === 'active')
    const at = activeAt >= 0 ? activeAt : steps.findIndex(st => !isFinished(st.status))
    const cur = steps[at]
    if (cur) finish(cur)
    // past the last step, work goes back to one left open earlier
    const following = steps.slice(at + 1).find(st => st.status === 'pending') ?? steps.find(st => st.status === 'pending')
    if (following) following.status = 'active'
  }
  let lastDone = -1
  for (const t of Array.isArray(input.done) ? input.done : []) {
    const st = typeof t === 'string' ? find(t) : undefined
    if (st?.status === 'active') lastDone = steps.indexOf(st)
    if (st) finish(st)
  }
  // finishing the step in progress moves on, as next does, unless the call names the new one itself
  if (lastDone >= 0 && typeof input.active !== 'string' && !steps.some(st => st.status === 'active')) {
    const following = steps.slice(lastDone + 1).find(st => st.status === 'pending') ?? steps.find(st => st.status === 'pending')
    if (following) following.status = 'active'
  }
  const active = typeof input.active === 'string' ? find(input.active) : undefined
  if (active) {
    const at = steps.indexOf(active)
    steps.forEach((st, i) => {
      if (st.status === 'active' && i !== at) {
        if (i < at) finish(st)
        else {
          st.status = 'pending'
          delete st.doneAt
        }
      }
    })
    active.status = 'active'
    delete active.doneAt
  }
  const failed = typeof input.failed === 'string' ? find(input.failed) : undefined
  if (failed) {
    failed.status = 'error'
    delete failed.doneAt
  }

  return { stages: next, missing }
}

// the new bar, or the refusal for a call that names steps the bar does not have
function normalize(input: Raw, prev: Plan | null, now: number, id: string): Plan | string {
  const sent = list(input.stages)
    .map(s => ({
      name: str(s.name, 80) || 'Stage',
      steps: list(s.steps).map(st => ({ title: str(st.title) || 'Step', status: status(st.status) })),
    }))
    .filter(s => s.steps.length > 0) as PlanStage[]
  const isPartial = sent.length === 0 && prev !== null
  // a resent plan keeps what was finished; short ops sent along with it apply on top
  const base = isPartial ? prev.stages : pointAt(prev ? carryDone(sent, prev.stages) : sent)
  const { stages, missing } = applyOps(base, input, now)
  if (missing.length > 0 && base.length > 0) {
    const titles = stages.flatMap(s => s.steps.map(st => st.title)).join(', ')
    return `plan_progress: "${id}" has no step ${missing.map(t => `"${str(t, 60)}"`).join(', ')}. Its steps: ${titles.slice(0, 400)}`
  }
  const steps = stages.flatMap(s => s.steps)
  const isAllDone = steps.length > 0 && steps.every(s => isFinished(s.status))
  const asked = input.state as PlanState
  const hasOps = input.next === true || Array.isArray(input.done) || typeof input.active === 'string' || typeof input.failed === 'string'
  const state: PlanState = ['running', 'needs_input', 'error', 'done'].includes(asked)
    ? asked
    : isPartial && !hasOps
      ? prev.state
      : isAllDone
      ? 'done'
      : steps.some(st => st.status === 'error')
        ? 'error'
        : 'running'

  if (state === 'done') for (const st of steps) if (!isFinished(st.status)) Object.assign(st, { status: 'done', doneAt: now })

  return {
    id,
    title: str(input.title, 80) || prev?.title || 'Plan',
    stages,
    state,
    note: input.note === undefined && isPartial && !hasOps ? prev.note : str(input.note, 160) || null,
    startedAt: prev ? prev.startedAt : now,
    endedAt: state === 'done' ? (prev?.endedAt ?? now) : null,
    touchedAt: now,
  }
}

// a resent plan keeps what is finished: a step sent as pending under a title that was done stays done
function carryDone(stages: PlanStage[], before: PlanStage[]): PlanStage[] {
  const history = new Map<string, PlanStep[]>()
  for (const st of before.flatMap(s => s.steps)) {
    const key = str(st.title).toLowerCase()
    const matches = history.get(key) ?? []
    matches.push(st)
    history.set(key, matches)
  }
  return stages.map(s => ({
    ...s,
    steps: s.steps.map(st => {
      const was = history.get(str(st.title).toLowerCase())?.shift()
      return was && isFinished(was.status) && (st.status === 'pending' || st.status === was.status) ? { ...st, status: was.status, doneAt: was.doneAt } : st
    }),
  }))
}

// with nothing in progress, the first open step is the current one
function pointAt(stages: PlanStage[]): PlanStage[] {
  const steps = stages.flatMap(s => s.steps)
  if (steps.some(st => st.status === 'active' || st.status === 'error')) return stages
  const first = steps.find(st => st.status === 'pending')
  return stages.map(s => ({ ...s, steps: s.steps.map(st => (st === first ? { ...st, status: 'active' as const } : st)) }))
}

type Where = { pos: number; total: number; stage: number; step: number; stageSize: number }

// pos counts the finished steps wherever they are; the current step is the active one, else the first still open
function where(p: Plan): Where {
  const steps = p.stages.flatMap((s, i) => s.steps.map((step, j) => ({ i, j, step })))
  const pos = p.state === 'done' ? steps.length : steps.filter(x => isFinished(x.step.status)).length
  const cur = p.state === 'done' ? undefined : (steps.find(x => x.step.status === 'active') ?? steps.find(x => !isFinished(x.step.status)))
  const stage = (cur ?? steps[steps.length - 1])?.i ?? 0

  return { pos, total: steps.length, stage, step: cur ? cur.j + 1 : (p.stages[stage]?.steps.length ?? 0), stageSize: p.stages[stage]?.steps.length ?? 0 }
}

const percentOf = (p: Plan) => {
  const w = where(p)
  return p.state === 'done' ? 100 : Math.round((Math.min(w.pos, w.total) / Math.max(1, w.total)) * 100)
}

// how long each finished step took (from the previous finish, or the plan's start) and each finished stage
function stepTimes(p: Plan): { steps: Map<PlanStep, number>; stages: (number | undefined)[] } {
  const ends = p.stages.flatMap(s => s.steps).flatMap(st => (!isFinished(st.status) || st.doneAt === undefined ? [] : [st.doneAt])).sort((a, b) => a - b)
  const startOf = (at: number) => Math.max(p.startedAt, ...ends.filter(t => t < at))
  const steps = new Map<PlanStep, number>()
  const stages = p.stages.map(s => {
    for (const st of s.steps) if (isFinished(st.status) && st.doneAt !== undefined) steps.set(st, Math.max(0, st.doneAt - startOf(st.doneAt)))
    const times = s.steps.map(st => isFinished(st.status) ? st.doneAt : undefined)
    if (times.some(t => t === undefined)) return undefined
    const done = times as number[]
    return Math.max(...done) - Math.min(...done.map(startOf))
  })
  return { steps, stages }
}

const elapsed = (ms: number) => {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  return sec < 3600 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

// HH:MM:SS in the machine's own time zone (checkpoint arrivals, the 5-hour reset)
const clock = (ms: number) => {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

// 1234 -> 1.23K, 900000 -> 900K, 186000000 -> 186M: three significant figures at most;
// a value that rounds up to 1000 of a unit is written in the next one (999600 -> 1M, not 1000K)
const UNITS = [['K', 1e3], ['M', 1e6], ['B', 1e9]] as const
const compact = (n: number): string => {
  for (let i = UNITS.length - 1; i >= 0; i--) {
    const [unit, size] = UNITS[i] ?? UNITS[0]
    const v = n / size
    if (v < 1) continue
    const r = Number(v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2))
    const up = UNITS[i + 1]
    return r >= 1000 && up ? `1${up[0]}` : `${r}${unit}`
  }
  return String(Math.round(n))
}

// ---------- design system ----------
// Modelled on Claude's own effort slider: a soft grey pipe whose fill is fine pixel squares, thinner and
// paler at the start, packing denser and deeper towards a white thumb. It moves with the work, live:
// while Claude's turn runs on a task, or its agents do, slow light drifts through the pixels towards the
// head, like matter carried down a pipe, more of it the more agents run, and the pixels sparkle hardest
// at the head; while the work pauses the light keeps drifting at half speed and the pixels twinkle softly,
// so a pause never looks frozen. A running state's icon is three level bars, dancing while work runs and
// swaying slowly while it pauses. A wait breathes, an error and a done bar stand still, every change glides in .42 s. Words
// are the app's own text, so they follow its light or dark theme; the drawings use mid-tone colours
// that read on either.
type Tone = { light: string; mid: string; deep: string }
const TONE: Record<PlanState, Tone> = {
  running: { light: '#CDBDFB', mid: '#9D84F2', deep: '#6F4FDF' },
  needs_input: { light: '#F8D9A0', mid: '#EBAA3C', deep: '#C47F0E' },
  error: { light: '#F7B4B0', mid: '#E5534B', deep: '#BE2B27' },
  done: { light: '#B6E4C3', mid: '#57BB78', deep: '#2B9653' },
}
const STATE_COLOR: Record<PlanState, string> = { running: TONE.running.mid, needs_input: TONE.needs_input.mid, error: TONE.error.mid, done: TONE.done.mid }
const STATE_GLYPH: Record<PlanState, string> = { running: '●', needs_input: '?', error: '!', done: '✓' }
const STATE_NAME: Record<PlanState, string> = { running: '进行中', needs_input: '需要输入', error: '出错', done: '完成' }
const AGENT_STATE: Record<AgentRun['state'], PlanState> = { running: 'running', waiting: 'needs_input', done: 'done', error: 'error' }
// budgets borrow the state tones: green while there is room, amber past half, red past 80%
const levelOf = (used: number): PlanState => (used >= 80 ? 'error' : used >= 50 ? 'needs_input' : 'done')
const SANS = `'Segoe UI Variable Text','Segoe UI',system-ui,-apple-system,'PingFang SC','Microsoft YaHei UI',sans-serif`
const MONO = `'Cascadia Mono','Cascadia Code',Consolas,'SF Mono',ui-monospace,monospace`
const EASE = 'cubic-bezier(.2,.8,.2,1)'
const GLIDE = 'dur=".42s" calcMode="spline" keyTimes="0;1" keySplines=".2 .8 .2 1" fill="freeze"'
const TRACK_FILL = 'rgba(128,128,128,.16)'
const TICK = 'rgba(128,128,128,.62)'
const THUMB_INK = '#3B3A36'
const THUMB_DIM = '#8C8A84'
const LEVELS = ['.3', '.48', '.66', '.84', '1'] // pixel opacities, start to head
// the pixel grid: a task track's squares, and a meter's finer and denser ones
type Grain = { pitch: number; px: number; floor: number }
const COARSE: Grain = { pitch: 3, px: 2.4, floor: 0.34 }
const FINE: Grain = { pitch: 2.5, px: 2, floor: 0.7 }
// how fast light drifts down a pipe, px a second; the user asked for it slow
const FLOW_SPEED = 20

// six twinkle phases of different lengths, so the field never pulses in step; tw1 and tw5 are the
// quick ones the head sparkles with
const CSS = `<style>
.tw0,.tw1,.tw2,.tw3,.tw4,.tw5{animation:tw 2.6s ease-in-out infinite}
.tw1{animation-duration:1.7s;animation-delay:-.7s}.tw2{animation-duration:3.3s;animation-delay:-1.6s}.tw3{animation-duration:2.2s;animation-delay:-1.1s}
.tw4{animation-duration:4.1s;animation-delay:-2.3s}.tw5{animation-duration:1.4s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:.2}}
.ts0,.ts1,.ts2,.ts3,.ts4,.ts5{animation:ts 3.6s ease-in-out infinite}
.ts1{animation-delay:-.6s}.ts2{animation-delay:-1.2s}.ts3{animation-delay:-1.8s}.ts4{animation-delay:-2.4s}.ts5{animation-delay:-3s}
@keyframes ts{0%,100%{opacity:1}50%{opacity:.35}}
.br{animation:br 2.4s cubic-bezier(.45,0,.55,1) infinite}@keyframes br{50%{opacity:.45}}
.eq{transform-box:fill-box;transform-origin:50% 100%;animation:eq .9s ease-in-out infinite alternate}
.e1{animation-duration:.7s;animation-delay:-.4s}.e2{animation-duration:1.1s;animation-delay:-.25s}
@keyframes eq{from{transform:scaleY(.28)}to{transform:scaleY(1)}}
.eq.slow{animation-name:eqs;animation-duration:2.4s}.e1.slow{animation-duration:1.9s}.e2.slow{animation-duration:3s}
@keyframes eqs{from{transform:scaleY(.45)}to{transform:scaleY(1)}}
.tn{font:600 11.5px ${SANS};fill:${THUMB_INK}}.tc{font:500 10.5px ${MONO};fill:${THUMB_DIM}}.tg{font:700 11.5px ${SANS}}
@media (prefers-reduced-motion:reduce){.tw0,.tw1,.tw2,.tw3,.tw4,.tw5,.ts0,.ts1,.ts2,.ts3,.ts4,.ts5,.br{animation:none}.flow,.glide,.eq{animation:none!important}}
</style>`

const svgOpen = (W: number, H: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
const esc = (s: string) =>
  [...s]
    .filter(ch => {
      const cp = ch.codePointAt(0) ?? 0
      return cp === 9 || cp === 10 || cp === 13 || (cp >= 32 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || cp >= 0x10000
    })
    .join('')
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
const hash = (a: number, b: number, k: number) => {
  const x = Math.sin(a * 127.1 + b * 311.7 + k * 74.7) * 43758.5453
  return x - Math.floor(x)
}
const seedOf = (s: string) => [...s].reduce((h, ch) => (h * 31 + (ch.codePointAt(0) ?? 0)) % 997, 7)
const isCjk = (ch: string) => /[⺀-鿿가-힣豈-﫿︰-﹏＀-￯]/.test(ch)
// estimated advance of a run in the UI face at a size, and in the mono face
const textWidth = (s: string, size = 12) =>
  [...s].reduce((w, ch) => w + size * (isCjk(ch) ? 1 : /[ilIjtf.,:;'|!·()\s]/.test(ch) ? 0.32 : /[mwMW@]/.test(ch) ? 0.84 : /[A-Z]/.test(ch) ? 0.64 : 0.54), 0)
const monoWidth = (s: string, size = 11) => [...s].reduce((w, ch) => w + size * (isCjk(ch) ? 1 : 0.6), 0)
const cut = (s: string, room: number, measure: (s: string) => number) => {
  if (measure(s) <= room) return s
  if (measure('…') > room) return ''
  const out = [...s]
  while (out.length > 0 && measure(`${out.join('')}…`) > room) out.pop()
  return `${out.join('').trimEnd()}…`
}

// the pixel field over [0, fill]: squares thin out and pale towards the start, pack in and brighten
// towards the head; each takes one of six twinkle phases, the quick ones near the head, so the field
// shimmers like a level meter and sparkles where the work arrives
function pixels(fill: number, H: number, seed: number, motion: 'tw' | 'ts' | '', grain: Grain): string {
  const { pitch, px, floor } = grain
  const rows = Math.max(1, Math.floor(H / pitch))
  const top = (H - rows * pitch) / 2 + (pitch - px) / 2
  const groups = new Map<string, string>()
  for (let col = 0; col * pitch < fill; col++) {
    const x = col * pitch + (pitch - px) / 2
    const u = Math.min(1, (x + px) / Math.max(px, fill))
    for (let r = 0; r < rows; r++) {
      if (hash(col + seed, r, 1) > floor + (1 - floor) * Math.pow(u, 0.9)) continue
      const level = Math.min(4, Math.floor(floor * 2 + u * 4.2 + hash(col + seed, r, 3) * 1.4))
      const roll = hash(col + seed, r, 2)
      const phase = motion === 'tw' && u > 0.75 ? (roll < 0.5 ? 1 : 5) : motion === 'tw' ? [0, 2, 3, 4][Math.floor(roll * 4)] : Math.floor(roll * 6)
      const key = `${level}${phase}`
      groups.set(key, `${groups.get(key) ?? ''}M${x.toFixed(1)} ${(top + r * pitch).toFixed(1)}h${px}v${px}h-${px}z`)
    }
  }
  return [...groups].map(([key, d]) => `<path${motion ? ` class="${motion}${key[1]}"` : ''} fill="#fff" fill-opacity="${LEVELS[Number(key[0])]}" d="${d}"/>`).join('')
}

type Motion = 'flow' | 'calm' | 'breathe' | 'still'

// a pipe of W x H at y: the grey track, then the pixel field over the filled part, coloured from the
// tone's light end to its deep end over a faint cloud of the same, and crossed by soft light drifting
// towards the head: while work flows, two layers at different spacings and speeds, so the drift never
// repeats in step, their packets closer together the more work runs (traffic); while it pauses, one
// softer layer at half speed. ids are prefixed, so several pipes can share one drawing
function pipe(id: string, W: number, H: number, y: number, fill: number, from: number, tone: Tone, motion: Motion, seed: number, grain: Grain, traffic = 0): { defs: string; body: string } {
  const r = H / 2
  const glide = Math.abs(from - fill) > 0.5
  const glideStyle = glide ? `<style>@keyframes ${id}grow{from{width:${from.toFixed(1)}px}to{width:${fill.toFixed(1)}px}}</style>` : ''
  // the spacing of the light packets; a short pipe (a meter) packs them closer so one is always in view
  const P = Math.min(W * 0.6, traffic >= 3 ? 60 : traffic === 2 ? 80 : 110)
  // each layer moves by exactly one spacing and starts over, so the loop is seamless; its keyframes carry
  // the distance literally, since a var() inside @keyframes does not animate in older WebKit (the mobile app)
  const drift = (spacing: number, speed: number, opacity: number) => {
    const name = `fl${Math.round(spacing)}`
    return (
      `<style>@keyframes ${name}{to{transform:translateX(${spacing.toFixed(1)}px)}}</style>` +
      `<g class="flow" style="animation:${name} ${(spacing / speed).toFixed(2)}s linear infinite" opacity="${opacity}">${Array.from(
        { length: Math.ceil(fill / spacing) + 2 },
        (_, k) => `<ellipse cx="${((k - 1) * spacing + spacing / 2).toFixed(1)}" cy="${H / 2}" rx="${(spacing * 0.36).toFixed(1)}" ry="${H}" fill="url(#${id}f)"/>`,
      ).join('')}</g>`
    )
  }
  const fog = motion === 'flow' ? drift(P, FLOW_SPEED, 0.9) + drift(P * 1.7, FLOW_SPEED * 0.6, 0.45) : motion === 'calm' ? drift(P, FLOW_SPEED * 0.5, 0.55) : ''
  const defs =
    `${glideStyle}<clipPath id="${id}c"><rect width="${fill.toFixed(1)}" height="${H}" rx="${r}"${glide ? ` class="glide" style="animation:${id}grow .42s ${EASE} both"` : ''}/></clipPath>` +
    `<mask id="${id}m" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">${pixels(fill, H, seed, motion === 'flow' ? 'tw' : motion === 'calm' ? 'ts' : '', grain)}</mask>` +
    `<linearGradient id="${id}g" gradientUnits="userSpaceOnUse" x1="0" x2="${Math.max(fill, 1).toFixed(1)}"><stop offset="0" stop-color="${tone.light}"/><stop offset=".55" stop-color="${tone.mid}"/><stop offset="1" stop-color="${tone.deep}"/></linearGradient>` +
    (fog ? `<radialGradient id="${id}f"><stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>` : '')
  const body =
    `<g transform="translate(0 ${y})"><rect width="${W}" height="${H}" rx="${r}" fill="${TRACK_FILL}"/>` +
    `<g clip-path="url(#${id}c)"${motion === 'breathe' ? ' class="br"' : ''}><rect width="${fill.toFixed(1)}" height="${H}" fill="url(#${id}g)" opacity=".16"/>` +
    `<g mask="url(#${id}m)"><rect width="${fill.toFixed(1)}" height="${H}" fill="url(#${id}g)"/>${fog}</g></g></g>`
  return { defs, body }
}

// the state as a 14 px icon: three level bars dancing while it runs, a mark in a dot otherwise
const ICON = 14
const ICON_MARK: Partial<Record<PlanState, string>> = {
  done: '<path d="M4.2 7.3l1.9 1.9 3.8-4.2" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  error: '<path d="M7 3.9v3.5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><circle cx="7" cy="10.1" r=".95" fill="#fff"/>',
  needs_input:
    '<path d="M5.3 5.5a1.75 1.75 0 1 1 2.5 1.6c-.55.27-.8.65-.8 1.2" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><circle cx="7" cy="10.4" r=".9" fill="#fff"/>',
}
// the three level bars: dancing while work runs, swaying slowly while it pauses
const levelBars = (paint: (i: number) => string, isLive: boolean) =>
  [0, 1, 2].map(i => `<rect class="eq e${i}${isLive ? '' : ' slow'}" x="${2.2 + i * 3.8}" y="2" width="2.4" height="10" rx="1.2" ${paint(i)}/>`).join('')
// isLive: something works on it right now; a running bar nobody works on sways slowly, as its pipe drifts slowly
function stateIcon(state: PlanState, isLive = true): string {
  const t = TONE[state]
  const body =
    state === 'running'
      ? levelBars(i => `fill="${i === 1 ? t.deep : t.mid}"`, isLive)
      : `<g${state === 'needs_input' ? ' class="br"' : ''}><circle cx="7" cy="7" r="6.2" fill="${t.mid}"/>${ICON_MARK[state] ?? ''}</g>`
  return `${svgOpen(ICON, ICON)}${CSS}${body}</svg>`
}

// a clock that counts by itself, so nothing redraws each second: each digit is a reel of its figures
// behind a one-line window, stepped by a CSS animation whose negative delay is the time already run.
// {{T:start}} becomes those seconds when the markup is handed over (liveSource, withTime)
const CLOCK_W = 48 // "59m 59s"
const REEL = 16
const CLOCK_CSS = `.ckt{font-variant-numeric:tabular-nums}
.rs1{animation:r10 10s steps(10) var(--d) infinite}.rs10{animation:r6 60s steps(6) var(--d) infinite}
.cc{animation:cc 600s linear var(--d) both}@keyframes cc{0%,9.99%{transform:translateX(-13.5px)}10%,99.99%{transform:translateX(-3.25px)}100%{transform:none}}
.rm1{animation:r10 600s steps(10) var(--d) infinite}.rm10{animation:r10 6000s steps(10) var(--d) infinite}.rmm{animation:hm 60s steps(1,end) var(--d) both}
@keyframes r10{to{transform:translateY(-${REEL * 10}px)}}@keyframes r6{to{transform:translateY(-${REEL * 6}px)}}@keyframes hm{from{opacity:0}to{opacity:1}}`

// x is the clock's left edge, top the window's top; the minutes part stays hidden for the first minute
function liveClock(x: number, top: number, start: number, cls: string, textCls: string, isCentered = false): string {
  const base = top + 12
  const reel = (cx: number, figures: string[], reelCls: string) =>
    `<g class="${reelCls}"><text class="${textCls} ckt" text-anchor="middle">${figures
      .map((f, i) => `<tspan x="${cx.toFixed(1)}" y="${base + i * REEL}">${f}</tspan>`)
      .join('')}</text></g>`
  const digits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
  const id = `ck${start}x${Math.round(x)}y${Math.round(top)}`
  return (
    `<style>.${id}{--d:-{{T:${start}}}s}.${id} .clockReels{display:{{SHORT:${start}}}}.${id} .clockFallback{display:{{LONG:${start}}}}@media(prefers-reduced-motion:reduce){.${id} .clockReels{display:none}.${id} .clockFallback{display:inline}}</style>` +
    `<g class="${cls} ${id}"><text class="${textCls} ckt clockFallback" x="${(x + CLOCK_W / 2).toFixed(1)}" y="${base}" text-anchor="middle">{{elapsed:${start}}}</text>` +
    `<clipPath id="${id}"><rect x="${(x - 2).toFixed(1)}" y="${top}" width="${CLOCK_W + 4}" height="${REEL}"/></clipPath>` +
    `<g class="clockReels"><g clip-path="url(#${id})"${isCentered ? ' class="cc"' : ''}><g class="rmm">${reel(x + 3.5, ['', ...digits.slice(1)], 'rm10')}${reel(x + 10.5, digits, 'rm1')}` +
    `<text x="${(x + 14).toFixed(1)}" y="${base}" class="${textCls}">m</text></g>` +
    `${reel(x + 31, digits.slice(0, 6), 'rs10')}${reel(x + 38, digits, 'rs1')}<text x="${(x + 41.5).toFixed(1)}" y="${base}" class="${textCls}">s</text></g></g></g>`
  )
}

const withTime = (template: string, now: number) =>
  template
    .replace(/\{\{T:(\d+)\}\}/g, (_, t: string) => Math.max(0, (now - Number(t)) / 1000).toFixed(1))
    .replace(/\{\{elapsed:(\d+)\}\}/g, (_, t: string) => elapsed(now - Number(t)))
    .replace(/\{\{(SHORT|LONG):(\d+)\}\}/g, (_, kind: string, t: string) => ((now - Number(t) >= 100 * 60_000) === (kind === 'LONG') ? 'inline' : 'none'))

// a drawing reloads whenever its markup changes; markup that differs only in when it was drawn keeps the
// source already shown, so its clock runs on instead of starting over
const lastSource = new Map<string, { template: string; source: string; minute: number }>()
function liveSource(id: string, template: string, now: number): string {
  const last = lastSource.get(id)
  const minute = Math.floor(now / 60_000)
  if (last?.template === template && (!template.includes('{{elapsed:') || last.minute === minute)) return last.source
  const source = withTime(template, now)
  lastSource.set(id, { template, source, minute })
  return source
}

// the session strip's icon while no turn runs: the three bars in grey, swaying slowly
const IDLE_ICON = `${svgOpen(ICON, ICON)}${CSS}${levelBars(() => 'fill="#8C8A84" fill-opacity=".6"', false)}</svg>`

// ---------- token sankey ----------
// the week's tokens as a small Sankey of blocks: the four kinds flow into the week's total, which splits into
// this session and the machine's other sessions. Shares are true to size, except that no flow draws thinner
// than a hairline, so all four kinds show (cache reads dwarf the rest); the card's labels carry the figures.
// Light drifts through the bands as it does down the pipes, at half speed while no turn runs. Mid tones and
// mid-grey words, since the app draws the card in its own light or dark theme
const SANKEY_KINDS = ['输入', '输出', '缓存写', '缓存读']
const SANKEY_FROM = ['#60A5FA', '#3B82F6', '#818CF8', '#6366F1']
const SANKEY_HUB = '#8B5CF6'
const SANKEY_TO = ['#F43F5E', '#FB7185']
const SANKEY_ICON_W = 36
const SANKEY_ICON_H = 14
const SANKEY_W = 300
const SANKEY_H = 112

const sankeyAlt = (kinds: TokenCounts, own: number) => {
  const total = tokenSum(kinds)
  const mine = Math.min(own, total)
  return `本周 ${compact(total)} tokens：${SANKEY_KINDS.map((k, i) => `${k} ${compact(kinds[i] ?? 0)}`).join('，')}；本会话 ${compact(mine)}，其他会话 ${compact(total - mine)}`
}

function sankeySvg(kinds: TokenCounts, own: number, isLive: boolean, isCard: boolean): string {
  const W = isCard ? SANKEY_W : SANKEY_ICON_W
  const H = isCard ? SANKEY_H : SANKEY_ICON_H
  const side = isCard ? 84 : 0 // room for the labels either side
  const node = isCard ? 6 : 3
  const gap = isCard ? 5 : 1
  const pad = isCard ? 16 : 0
  const hair = isCard ? 1.5 : 0.8
  const total = Math.max(1, tokenSum(kinds))
  const mine = Math.min(own, total)
  const right = [mine, total - mine]
  // what the four kinds share; the hub and the right side keep the same thickness, so no band changes width
  const room = H - 2 * pad - 3 * gap
  const sizes = (vals: number[]) => {
    const lifted = vals.map(v => Math.max(hair, (v / total) * room))
    const k = room / lifted.reduce((a, b) => a + b, 0)
    return lifted.map(h => h * k)
  }
  const stack = (hs: number[], top: number, g: number) => hs.map((_, i) => top + hs.slice(0, i).reduce((a, b) => a + b, 0) + i * g)
  const lh = sizes([...kinds])
  const rh = sizes(right)
  const x0 = side
  const xh = (W - node) / 2
  const x2 = W - side - node
  const hubY = pad + 1.5 * gap
  const ly = stack(lh, pad, gap)
  const ry = stack(rh, hubY - gap / 2, gap)
  const hl = stack(lh, hubY, 0)
  const hr = stack(rh, hubY, 0)
  const f = (n: number) => n.toFixed(1)
  const band = (xa: number, ya: number, xb: number, yb: number, h: number) => {
    const c = (xb - xa) * 0.55
    return `M${f(xa)} ${f(ya)}C${f(xa + c)} ${f(ya)} ${f(xb - c)} ${f(yb)} ${f(xb)} ${f(yb)}V${f(yb + h)}C${f(xb - c)} ${f(yb + h)} ${f(xa + c)} ${f(ya + h)} ${f(xa)} ${f(ya + h)}Z`
  }
  const links = [
    ...lh.map((h, i) => ({ d: band(x0 + node, ly[i] ?? 0, xh, hl[i] ?? 0, h), xa: x0 + node, xb: xh, from: SANKEY_FROM[i] ?? SANKEY_HUB, to: SANKEY_HUB })),
    ...rh.map((h, j) => ({ d: band(xh + node, hr[j] ?? 0, x2, ry[j] ?? 0, h), xa: xh + node, xb: x2, from: SANKEY_HUB, to: SANKEY_TO[j] ?? SANKEY_HUB })),
  ]
  const r = isCard ? 1.5 : 0.5
  const block = (x: number, y: number, h: number, fill: string) => `<rect x="${f(x)}" y="${f(y)}" width="${node}" height="${f(h)}" rx="${r}" fill="${fill}"/>`
  const blocks =
    lh.map((h, i) => block(x0, ly[i] ?? 0, h, SANKEY_FROM[i] ?? SANKEY_HUB)).join('') +
    block(xh, hubY, room, SANKEY_HUB) +
    rh.map((h, j) => block(x2, ry[j] ?? 0, h, SANKEY_TO[j] ?? SANKEY_HUB)).join('')
  const spacing = isCard ? 70 : 18
  const speed = (isCard ? 24 : 8) * (isLive ? 1 : 0.5)
  const fog =
    `<g clip-path="url(#sc)"><g class="flow" style="animation:sk ${(spacing / speed).toFixed(2)}s linear infinite" opacity=".75">` +
    Array.from({ length: Math.ceil(W / spacing) + 2 }, (_, k) => `<ellipse cx="${f((k - 1) * spacing + spacing / 2)}" cy="${H / 2}" rx="${f(spacing * 0.32)}" ry="${H}" fill="url(#sf)"/>`).join('') +
    '</g></g>'
  // labels, pushed apart where hairline flows sit close together
  const spread = (ys: number[]) => ys.reduce<number[]>((out, y) => [...out, Math.max(y, (out[out.length - 1] ?? -Infinity) + 12)], [])
  const label = (x: number, y: number, anchor: string, name: string, value: number) =>
    `<text x="${f(x)}" y="${f(y)}" text-anchor="${anchor}" class="sl">${name} <tspan class="sv">${compact(value)}</tspan></text>`
  const words = isCard
    ? spread(lh.map((h, i) => (ly[i] ?? 0) + h / 2 + 3.5)).map((y, i) => label(x0 - 6, y, 'end', SANKEY_KINDS[i] ?? '', kinds[i] ?? 0)).join('') +
      spread(rh.map((h, j) => (ry[j] ?? 0) + h / 2 + 3.5)).map((y, j) => label(x2 + node + 6, y, 'start', j === 0 ? '本会话' : '其他会话', right[j] ?? 0)).join('') +
      label(xh + node / 2, hubY - 5, 'middle', '本周', total)
    : ''
  return (
    `${svgOpen(W, H)}${CSS}<style>@keyframes sk{to{transform:translateX(${spacing}px)}}.sl{font:500 10.5px ${SANS};fill:${THUMB_DIM}}.sv{font-weight:700}</style>` +
    `<defs>${links.map((l, k) => `<linearGradient id="sg${k}" gradientUnits="userSpaceOnUse" x1="${f(l.xa)}" x2="${f(l.xb)}"><stop offset="0" stop-color="${l.from}"/><stop offset="1" stop-color="${l.to}"/></linearGradient>`).join('')}` +
    `<clipPath id="sc">${links.map(l => `<path d="${l.d}"/>`).join('')}</clipPath>` +
    `<radialGradient id="sf"><stop offset="0" stop-color="#fff" stop-opacity=".8"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>` +
    `${links.map((l, k) => `<path d="${l.d}" fill="url(#sg${k})" fill-opacity=".55"/>`).join('')}${fog}${blocks}${words}</svg>`
  )
}

const agentClock = (start: number) =>
  `${svgOpen(CLOCK_W, REEL)}<style>${CLOCK_CSS}.ag{font:500 11px ${MONO};fill:${THUMB_DIM}}</style>${liveClock(0, 0, start, 'ac', 'ag')}</svg>`

// the hover layer draws in a sandboxed frame; its page must stay see-through in either theme
const SEE_THROUGH = '<style>:root,html,body{background:transparent!important;color-scheme:light dark;margin:0;overflow:hidden}svg{display:block}</style>'
const HOVER_CSS = `<style>
.tp{opacity:0;transform:translateY(3px);transition:opacity .16s ${EASE},transform .16s ${EASE};pointer-events:none}
.tch{fill:#262624;fill-opacity:.94;stroke:rgba(255,255,255,.12)}
.tw{font:500 11px ${SANS};fill:#F5F4EF}.tm{font:400 11px ${MONO};fill:#C9C6BD}
.kv{opacity:0;transition:opacity .16s ${EASE}}.kb:hover .kv{opacity:1}
.ck{font:500 11px ${MONO};fill:${THUMB_INK}}
${CLOCK_CSS}
</style>`

// a hover chip laid over the track: words in the UI face, times in mono
function tip(k: string, x: number, words: string, data: string, W: number, H: number): string {
  const room = Math.max(0, W - 20)
  const shownData = cut(data, Math.min(monoWidth(data, 11), room * 0.65), s => monoWidth(s, 11))
  const shownWords = cut(words, Math.max(0, room - (shownData ? 8 + monoWidth(shownData, 11) : 0)), s => textWidth(s, 11))
  const tw = textWidth(shownWords, 11) + (shownData ? 8 + monoWidth(shownData, 11) : 0) + 18
  const tx = Math.max(1, Math.min(W - tw - 1, x - tw / 2))
  return (
    `<g class="tp p${k}"><title>${esc(words)}${data ? ` · ${esc(data)}` : ''}</title><rect x="${tx.toFixed(1)}" y="${H / 2 - 9}" width="${tw.toFixed(1)}" height="18" rx="9" class="tch"/>` +
    `<text x="${(tx + 9).toFixed(1)}" y="${H / 2 + 4}"><tspan class="tw">${esc(shownWords)}</tspan>${shownData ? `<tspan class="tm" dx="8">${esc(shownData)}</tspan>` : ''}</text></g>`
  )
}

// ---------- task track (desktop) ----------
// the pipe across the whole drawing, stage boundaries as ticks and steps as dots on it, and the white
// thumb on the head carrying the stage and step; a see-through layer on top carries the hover parts:
// each checkpoint's arrival time and the run time on the thumb
const ROW_H = 24
const TRACK_H = 16
const NARROW = 150 // track px below which the thumb is a plain knob

type Row = { base: string; overlay: string }
const drawnRows = new WeakMap<Plan, { key: string; row: Row }>()
// the head each row showed last time it was drawn, so a change glides from there
const lastHead = new Map<string, number>()

// traffic: how much works on the bar right now, the main turn and each running agent counting one
function trackSvg(p: Plan, W: number, traffic: number): Row {
  const key = `${W}|${traffic}`
  const cached = drawnRows.get(p)
  if (cached?.key === key) return cached.row
  const row = drawTrack(p, W, traffic)
  drawnRows.set(p, { key, row })
  return row
}

function drawTrack(p: Plan, W: number, traffic: number): Row {
  const H = ROW_H
  const cy = H / 2
  const w = where(p)
  const done = p.state === 'done'
  const tone = TONE[p.state]
  const fill = (done ? 1 : Math.min(1, w.pos / Math.max(1, w.total))) * W
  const from = lastHead.get(p.id) ?? fill
  lastHead.set(p.id, fill)
  // live: it flows while something works on it, and drifts at half speed while the work pauses
  const motion: Motion = p.state === 'running' ? (traffic > 0 ? 'flow' : 'calm') : p.state === 'needs_input' ? 'breathe' : 'still'
  const tube = pipe('p', W, TRACK_H, (H - TRACK_H) / 2, fill, from, tone, motion, seedOf(p.id), COARSE, traffic)

  // checkpoints, and their hover chips: the name, when it was reached and how long it took
  const took = stepTimes(p)
  const rules: string[] = []
  let marks = ''
  let hits = ''
  let tips = ''
  let k = 0
  p.stages.forEach((s, i) => {
    s.steps.forEach((_, j) => {
      if (k > 0) {
        const x = (k / w.total) * W
        const isStage = j === 0
        const paint = x <= fill + 0.5 ? 'fill="#fff" fill-opacity=".92"' : `fill="${TICK}"`
        marks += isStage
          ? `<rect x="${(x - 1).toFixed(1)}" y="${cy - 5}" width="2" height="10" rx="1" ${paint}/>`
          : `<circle cx="${x.toFixed(1)}" cy="${cy}" r="1.5" ${paint}/>`
        const before = p.stages[i - 1]
        const ended = isStage ? (before?.steps ?? []) : [s.steps[j - 1]]
        const doneAts = ended.map(st => st?.doneAt)
        const reachedAt = doneAts.length > 0 && doneAts.every(t => t !== undefined) ? Math.max(...(doneAts as number[])) : undefined
        const ms = isStage ? took.stages[i - 1] : took.steps.get(s.steps[j - 1] as PlanStep)
        const label = isStage ? `${before?.name ?? ''} 阶段` : (s.steps[j - 1]?.title ?? '')
        const data = reachedAt === undefined ? '未到达' : `${clock(reachedAt)}${ms === undefined ? '' : ` · ${elapsed(ms)}`}`
        hits += `<rect class="h${k}" x="${(x - 6).toFixed(1)}" width="12" height="${H}" fill="#000" fill-opacity="0"/>`
        tips += tip(String(k), x, label, data, W, H)
        rules.push(`.h${k}:hover~.p${k}`)
      }
      k++
    })
  })

  // the thumb: stage and step while it runs, a mark and the stage while it waits or failed, the total time once done
  const glyph = done ? '✓' : p.state === 'needs_input' ? '?' : p.state === 'error' ? '!' : ''
  const name = done ? (p.endedAt ? elapsed(p.endedAt - p.startedAt) : '完成') : (p.stages[w.stage]?.name ?? '')
  const count = done ? '' : `${w.step}/${w.stageSize}`
  const isKnob = W < NARROW
  const glyphW = glyph ? 12 : 0
  const countW = count ? monoWidth(count, 10.5) : 0
  const shown = isKnob ? '' : cut(name, Math.max(40, W * 0.4 - countW - glyphW - 24), s => textWidth(s, 11.5))
  const labelW = glyphW + (shown ? textWidth(shown, 11.5) : 0) + (shown && count ? 6 : 0) + countW
  // a running thumb is wide enough for its clock too, so hovering it does not change its size
  const kw = isKnob ? 20 : Math.round((done ? labelW : Math.max(labelW, CLOCK_W)) + 22)
  const clampX = (x: number) => Math.max(kw / 2, Math.min(W - kw / 2, x))
  const kx = clampX(fill)
  const kFrom = clampX(from)
  const glideKnob =
    Math.abs(kFrom - kx) > 0.5 ? `<style>@keyframes thumbGlide{from{transform:translate(${kFrom.toFixed(1)}px,0)}to{transform:translate(${kx.toFixed(1)}px,0)}}</style>` : ''
  const thumbShape = `<rect x="${-kw / 2}" y="${cy - 10}" width="${kw}" height="20" rx="10" fill="#fff" stroke="rgba(0,0,0,.08)" filter="url(#ts)"/>`
  const label = isKnob
    ? ''
    : `<text x="${(-labelW / 2).toFixed(1)}" y="${cy + 4}">${glyph ? `<tspan class="tg" style="fill:${tone.deep}">${glyph}</tspan>` : ''}` +
      `${shown ? `<tspan class="tn" dx="${glyph ? 4 : 0}">${esc(shown)}</tspan>` : ''}${count ? `<tspan class="tc" dx="${shown ? 6 : 0}">${count}</tspan>` : ''}</text>`
  const thumb = `<g transform="translate(${kx.toFixed(1)} 0)"${glideKnob ? ` class="glide" style="animation:thumbGlide .42s ${EASE} both"` : ''}>${glideKnob}${thumbShape}${label}</g>`
  const face =
    done || isKnob
      ? ''
      : `<g class="kb"><rect x="${-kw / 2}" y="${cy - 10}" width="${kw}" height="20" fill="#000" fill-opacity="0"/>` +
        `<g class="kv"><rect x="${-kw / 2}" y="${cy - 10}" width="${kw}" height="20" rx="10" fill="#fff"/>${liveClock(-CLOCK_W / 2, cy - 8, p.startedAt, 'kc', 'ck', true)}</g></g>`

  const defs = `<defs>${tube.defs}<filter id="ts" x="-30%" y="-50%" width="160%" height="220%"><feDropShadow dx="0" dy="1" stdDeviation="1.4" flood-color="#000" flood-opacity=".28"/></filter></defs>`
  const open = svgOpen(W, H)
  const base = `${open}${CSS}${defs}${tube.body}${marks}${thumb}</svg>`
  const overlay =
    `${open}${SEE_THROUGH}${HOVER_CSS}${rules.length ? `<style>${rules.join(',')}{opacity:1;transform:none}</style>` : ''}` +
    `${hits}<g transform="translate(${kx.toFixed(1)} 0)">${face}</g>${tips}</svg>`

  return { base, overlay }
}

const rowAlt = (p: Plan) => {
  const w = where(p)
  return p.state === 'done'
    ? `${p.title}：完成，共 ${w.total} 步${p.endedAt ? `，用时 ${elapsed(p.endedAt - p.startedAt)}` : ''}`
    : `${p.title}：${STATE_NAME[p.state]}，${p.stages[w.stage]?.name ?? ''} ${w.step}/${w.stageSize}，${percentOf(p)}%${p.note ? `，${p.note}` : ''}`
}

// ---------- agents ----------

// claude-haiku-4-5-20251001 -> haiku 4.5; an alias stays as given
const modelName = (m: string) => {
  const r = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m)
  return r ? `${r[1]} ${r[2]}.${r[3]}` : m
}
const agentSpec = (a: AgentRun) => [a.model ? modelName(a.model) : '', a.effort ?? ''].filter(Boolean).join(' · ')
const isLive = (a: AgentRun) => a.state === 'running' || a.state === 'waiting'

// all of a small batch; in a big one the unfinished first, then the latest, the rest folded into one row
function visibleAgents(p: Plan, max: number): { shown: AgentRun[]; hidden: AgentRun[] } | null {
  const all = p.agents ?? []
  if (all.length === 0) return null
  if (all.length <= max) return { shown: all, hidden: [] }
  const keep = new Set(all.filter(isLive).slice(0, max - 1).map(a => a.id))
  for (const a of [...all].reverse()) {
    if (keep.size >= max - 1) break
    keep.add(a.id)
  }
  return { shown: all.filter(a => keep.has(a.id)), hidden: all.filter(a => !keep.has(a.id)) }
}

// ---------- terminal drawing (text) ----------

const isWide = (cp: number) =>
  cp > 0xffff || (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
const cellsOf = (s: string) => [...s].reduce((w, ch) => w + (isWide(ch.codePointAt(0) ?? 0) ? 2 : 1), 0)

// the bar as text: finished share filled, stage boundaries ┃, step boundaries • where there is room
function barText(p: Plan, W: number): { done: string; rest: string } {
  const w = where(p)
  const filled = Math.round((p.state === 'done' ? 1 : w.pos / Math.max(1, w.total)) * W)
  const marks = new Map<number, string>()
  let k = 0
  for (const s of p.stages) {
    s.steps.forEach((_, j) => {
      const x = Math.round((k / Math.max(1, w.total)) * W)
      if (k > 0 && x < W && (j === 0 || (W >= w.total * 3 && !marks.has(x)))) marks.set(x, j === 0 ? '┃' : '•')
      k++
    })
  }
  let done = ''
  let rest = ''
  for (let x = 0; x < W; x++) {
    const ch = marks.get(x) ?? (x < filled ? '━' : '─')
    if (x < filled) done += ch
    else rest += ch
  }
  return { done, rest }
}

// ---------- usage meters ----------
// small pipes lit in the budget's tone; a tick on a limit's pipe marks how much of its window has gone,
// so usage running ahead of the tick is spending faster than the window refills

// rate limits are per account, so the newest reading any session took is shared through $.store
const LIMITS_KEY = 'limits'
const LIMIT_LABEL: Record<string, string> = { five_hour: '5小时', seven_day: '每周', spend_limit: '额度' }
const HOUR_MS = 3_600_000
const WEEK_MS = 7 * 24 * HOUR_MS
const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR_MS, seven_day: WEEK_MS }
const METER_W = 64
const METER_H = 10
const METER_SVG_H = 14
const METER_CELLS = 10
const PACE = '#7A7871'
// the fill each meter showed last, so a new reading glides from there
const lastMeter = new Map<string, number>()

type Reading = { at: number; limits: Limit[] }
const finiteCount = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0
const limitsOf = (v: unknown): Limit[] => list(v)
  .filter(l => typeof l.kind === 'string' && typeof l.percentUsed === 'number' && Number.isFinite(l.percentUsed) && l.percentUsed >= 0)
  .map(l => ({ kind: l.kind as string, percentUsed: l.percentUsed as number, ...(typeof l.resetsAt === 'string' ? { resetsAt: l.resetsAt } : {}) }))
const readingOf = (v: unknown): Reading | null =>
  v !== null && typeof v === 'object' && Number.isFinite((v as Reading).at) && Array.isArray((v as Reading).limits)
    ? { at: (v as Reading).at, limits: limitsOf((v as Reading).limits) } : null

const untilReset = (ms: number) => {
  const m = Math.max(0, Math.ceil(ms / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return d > 0 ? `${d}d${h}h` : h > 0 ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${m % 60}m`
}

// resetIn: the countdown; resetAt: the clock time, for the 5-hour window; elapsed: the share of the window gone
type Meter = { key: string; label: string; used: number | null; resetIn: string | null; resetAt: string | null; elapsed: number | null }

function metersOf(u: Usage, now: number): Meter[] {
  const out: Meter[] = [{ key: 'context', label: '上下文', used: u.contextPercent, resetIn: null, resetAt: null, elapsed: null }]
  for (const l of u.limits) {
    const resets = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    // a window that has reset since the reading starts again from zero
    const isReset = resets <= now
    const isKnown = !Number.isNaN(resets) && !isReset
    const windowMs = WINDOW_MS[l.kind]
    out.push({
      key: l.kind,
      label: LIMIT_LABEL[l.kind] ?? l.kind,
      used: isReset ? 0 : l.percentUsed,
      resetIn: isKnown ? untilReset(resets - now) : null,
      resetAt: isKnown && l.kind === 'five_hour' ? clock(resets).slice(0, 5) : null,
      elapsed: windowMs && isKnown ? Math.min(1, Math.max(0, 1 - (resets - now) / windowMs)) : isReset && windowMs ? 0 : null,
    })
  }
  return out
}

const meterValue = (m: Meter) => (m.used === null ? '—' : `${Math.round(m.used)}%`)

function meterSvg(m: Meter): string {
  const used = Math.min(100, Math.max(0, m.used ?? 0))
  const fill = (used / 100) * METER_W
  const from = lastMeter.get(m.key) ?? fill
  lastMeter.set(m.key, fill)
  const tube = pipe('m', METER_W, METER_H, (METER_SVG_H - METER_H) / 2, fill, from, TONE[levelOf(used)], used >= 90 ? 'breathe' : 'calm', seedOf(m.key), FINE)
  const tick = m.elapsed === null ? '' : `<rect x="${Math.min(METER_W - 1.5, Math.max(0, m.elapsed * METER_W - 0.75)).toFixed(1)}" y="1" width="1.5" height="${METER_SVG_H - 2}" rx=".75" fill="${PACE}"/>`
  return `${svgOpen(METER_W, METER_SVG_H)}${CSS}<defs>${tube.defs}</defs>${tube.body}${tick}</svg>`
}

async function refreshLimits($: EngineInterface) {
  const shared = readingOf(await $.store.get(LIMITS_KEY))
  if (shared && shared.at > (await read($, usage)).at) await update($, usage, u => ({ ...u, limits: shared.limits, at: shared.at }))
}

// ---------- tokens ----------
// each session keeps its own hourly totals in the store, so no write can overwrite another session's;
// the band adds up every session's hours inside the weekly window. Only sessions with this mod loaded
// count, on this machine
const TOKENS = 'tok:'
type Tally = Record<string, TokenCounts>
const tallyOf = (v: unknown): Tally => v !== null && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).filter(([h, c]) => Number.isFinite(Number(h)) && Number(h) >= 0 && Array.isArray(c)).map(([h, c]) => [h, [0, 1, 2, 3].map(i => finiteCount(c[i])) as TokenCounts]))
  : {}
const countsOf = (u: ModelUsage): TokenCounts => [u.input_tokens, u.output_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].map(finiteCount) as TokenCounts
const addCounts = (a: TokenCounts | null, b: TokenCounts): TokenCounts => [0, 1, 2, 3].map(i => (a?.[i] ?? 0) + (b[i] ?? 0)) as TokenCounts
const tokenSum = (c: TokenCounts) => c[0] + c[1] + c[2] + c[3]
// this session's own tally, kept in memory and written through; one write at a time, so agents
// finishing together do not drop each other's counts
let tally: { key: string; hours: Tally } | null = null
let tallyQueue: Promise<unknown> = Promise.resolve()

const tallySum = (hours: Tally) => Object.values(hours).reduce((sum, c) => sum + tokenSum(c), 0)

function countTokens($: EngineInterface, counts: TokenCounts) {
  const moment = Promise.all([$.session.id(), $.clock.now()])
  tallyQueue = tallyQueue
    .then(async () => {
      const [sessionId, now] = await moment
      const key = TOKENS + sessionId
      if (tally?.key !== key) tally = { key, hours: tallyOf(await $.store.get(key)) }
      const hour = Math.floor(now / HOUR_MS) * HOUR_MS
      const hours = tally.hours
      hours[String(hour)] = addCounts(hours[String(hour)] ?? null, counts)
      for (const h of Object.keys(hours)) if (Number(h) < now - WEEK_MS - HOUR_MS) delete hours[h]
      await update($, usage, u => ({ ...u, tokens: addCounts(u.tokens, counts) }))
      await update($, session, s => ({ ...s, tokens: tallySum(hours) }))
      await $.store.set(key, hours)
    })
    .catch(() => undefined)
  return tallyQueue
}

// the start of the weekly window: its reset less a week, or a week back while no reading names it;
// a window that has reset since the last reading started anew at that reset
function weekStart(u: Usage, now: number): number {
  const resets = Date.parse(u.limits.find(l => l.kind === 'seven_day')?.resetsAt ?? '')
  if (Number.isNaN(resets)) return now - WEEK_MS
  return resets <= now ? resets : resets - WEEK_MS
}

function refreshTokens($: EngineInterface) {
  // Serialize recounts with request counts so an older snapshot cannot replace a new count.
  tallyQueue = tallyQueue.catch(() => undefined).then(async () => {
    const now = await $.clock.now()
    const since = weekStart(await read($, usage), now)
    const own = TOKENS + (await $.session.id())
    let sum: TokenCounts = [0, 0, 0, 0]
    let ownSum = 0
    for (const key of await $.store.keys()) {
      if (!key.startsWith(TOKENS)) continue
      const hours = tallyOf(await $.store.get(key))
      // a session that counted nothing for longer than the window says nothing any more
      if (key !== own && Object.keys(hours).every(h => Number(h) < now - WEEK_MS - HOUR_MS)) {
        await $.store.delete(key)
        continue
      }
      for (const [h, c] of Object.entries(hours)) {
        const at = Number(h)
        // ponytail: hour buckets, so the hour the window starts in counts whole
        if (at <= now && at + HOUR_MS > since) sum = addCounts(sum, c)
        if (key === own) ownSum += tokenSum(c)
      }
    }
    await update($, usage, u => ({ ...u, tokens: sum }))
    await update($, session, s => ({ ...s, tokens: ownSum }))
  })
  return tallyQueue
}

// ---------- engine glue ----------

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'plan'

const isOpenPlan = (p: Plan) => p.state === 'running' && !p.stages.flatMap(s => s.steps).every(s => isFinished(s.status))

// the running bar the main turn works on: the one the model moved last
const focusOf = (all: readonly Plan[]) =>
  all.filter(p => p.state === 'running').reduce<Plan | null>((best, p) => (!best || (p.touchedAt ?? 0) >= (best.touchedAt ?? 0) ? p : best), null)

// adds or replaces one bar by id; keeps at most MAX_BARS, dropping finished ones first.
// Computed inside update() from the latest list, so concurrent writers (parallel agents) do not drop each other
function placeBar(all: readonly Plan[], next: Plan): Plan[] {
  const prev = all.find(p => p.id === next.id)
  // an update keeps its row and the agents already on it; a new bar goes to the bottom
  const kept = prev ? { ...next, agents: prev.agents } : next
  const rest = prev ? all.map(p => (p.id === next.id ? kept : p)) : [...all, next]
  while (rest.length > MAX_BARS) {
    const doneAt = rest.findIndex(p => p.state === 'done')
    rest.splice(doneAt >= 0 ? doneAt : 0, 1)
  }
  return rest
}

// $.state lives as long as the process, so the bars are kept per session in the store as well
const SAVED = 'plans:'
const KEEP_SESSIONS = 20
let saveQueue: Promise<unknown> = Promise.resolve()

function save($: EngineInterface) {
  const snapshot = Promise.all([$.session.id(), read($, plans)])
  saveQueue = saveQueue.catch(() => undefined).then(async () => {
    const [sessionId, all] = await snapshot
    const key = SAVED + sessionId
    if (all.length === 0) {
      await $.store.delete(key)
      return
    }
    // agents do not outlive the process that ran them, so a restored bar comes back without them
    await $.store.set(key, all.map(p => ({ ...p, agents: [] })))
    // the oldest other sessions' bars go past KEEP_SESSIONS; this session's own key never does
    const others = (await $.store.keys()).filter(k => k.startsWith(SAVED) && k !== key)
    for (const old of others.slice(0, Math.max(0, others.length - (KEEP_SESSIONS - 1)))) await $.store.delete(old)
  })
  return saveQueue
}

function savedPlan(v: unknown): v is Plan {
  if (!v || typeof v !== 'object') return false
  const p = v as Plan
  return typeof p.id === 'string' && p.id.length > 0 && typeof p.title === 'string'
    && ['running', 'needs_input', 'error', 'done'].includes(p.state)
    && Number.isFinite(p.startedAt) && (p.endedAt == null || Number.isFinite(p.endedAt))
    && (p.touchedAt === undefined || Number.isFinite(p.touchedAt)) && (p.note === null || typeof p.note === 'string')
    && Array.isArray(p.stages) && p.stages.length > 0 && p.stages.every(s => s && typeof s.name === 'string'
      && Array.isArray(s.steps) && s.steps.length > 0 && s.steps.every(st => st && typeof st.title === 'string'
        && STATUSES.includes(st.status) && (st.doneAt === undefined || Number.isFinite(st.doneAt))))
}

async function restore($: EngineInterface) {
  const saved = await $.store.get(SAVED + (await $.session.id()))
  const restored = Array.isArray(saved) ? saved.filter(savedPlan).reduce<Plan[]>((all, p) => placeBar(all, { ...p, agents: [] }), []) : []
  await update($, plans, () => restored)
}

async function editBars($: EngineInterface, change: (all: readonly Plan[]) => Plan[]) {
  await update($, plans, change)
  await save($)
}

// builds a bar from the latest stored one inside update(), so back-to-back calls never work from a stale copy;
// make returns a string to refuse, and the list stays as it was
async function editPlan($: EngineInterface, id: string, make: (prev: Plan | null) => Plan | string): Promise<Plan | string> {
  let made = '' as Plan | string
  await update($, plans, all => {
    made = make(all.find(p => p.id === id) ?? null)
    return typeof made === 'string' ? [...all] : placeBar(all, made)
  })
  if (typeof made !== 'string') await save($)
  return made
}

async function dropPlan($: EngineInterface, id: string) {
  lastHead.delete(id)
  for (const key of lastSource.keys()) if (key.startsWith(`${id}/`)) lastSource.delete(key)
  await editBars($, all => all.filter(p => p.id !== id))
}

// ---------- agents: drawn from engine events alone, no model calls ----------
// each subagent lives on the open task bar it was started under, or on its parent agent's bar.
// Module maps: a reload forgets running agents, whose rows then stay until the bar is closed.
const agentHome = new Map<string, string>() // agentId -> bar id
const toolUses = new Map<string, string>() // tool_use_id -> agentId, to find who waits on a permission
const waiting = new Set<string>()

function addRun(p: Plan, run: AgentRun, parentId: string | undefined): Plan {
  const all = [...(p.agents ?? [])]
  let at = all.length
  const parentAt = parentId ? all.findIndex(a => a.id === parentId) : -1
  if (parentAt >= 0) {
    at = parentAt + 1
    while (at < all.length && (all[at]?.depth ?? 0) > 0) at++
  }
  all.splice(at, 0, run)
  while (all.length > MAX_AGENTS) {
    const old = all.findIndex(a => !isLive(a))
    if (old < 0) break
    all.splice(old, 1)
  }
  return { ...p, agents: all }
}

// changes one agent's row inside the latest list
async function editAgent($: EngineInterface, agentId: string, change: (a: AgentRun) => AgentRun) {
  const home = agentHome.get(agentId)
  if (!home) return
  await update($, plans, all =>
    all.map(p => {
      if (p.id !== home || !p.agents?.some(a => a.id === agentId)) return p
      return { ...p, agents: p.agents.map(a => (a.id === agentId ? change(a) : a)) }
    }),
  )
}

const STEP_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string' },
    status: { enum: STATUSES, description: 'Default pending' },
  },
}

// edits are the work that makes an open bar worth updating before the turn ends
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
// prompts the person typed (terminal, phone, desktop app): answering one clears "needs input"
const PERSON = new Set(['composer', 'bridge', 'sdk'])
// a tool as the strip names it: an MCP tool by its own name, the question tool by what it means for the person
const toolLabel = (tool: string) => (tool === 'AskUserQuestion' ? '等你回答' : tool.startsWith('mcp__') ? tool.slice(tool.lastIndexOf('__') + 2) : tool)

export const register: Register = on => {
  // per-turn bookkeeping; module variables are fine here, a reload just starts a fresh count
  let workCalls = 0
  // tool calls of the main conversation still running, for the strip's activity
  let mainTools = 0
  let isPlanTouched = false
  // the 5-hour window (by its reset) already told to wrap up, and whether this turn was told
  let quotaWarned = ''
  let isQuotaStop = false
  let isWaitingOnBackground = false
  // where the band was drawn last, so the terminal alone gets a second-by-second redraw
  let band: { surface: string; isWorking: boolean } | null = null
  // session.start fires again on an enable or a worker respawn, which may keep this module's variables
  let timers: { cancel: () => void }[] = []

  on('session.start', async ($, e, next) => {
    for (const timer of timers) timer.cancel()
    await $.tool.register({
      name: 'plan_progress',
      description: 'Live progress bar above the prompt, one per id. Create with title + stages; update with short ops (next, done, active, failed) or state.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Bar id; reuse it for updates' },
          title: { type: 'string' },
          stages: {
            type: 'array',
            description: 'Full breakdown: when creating, or resent under the same id when the plan changes',
            items: { type: 'object', required: ['name', 'steps'], properties: { name: { type: 'string' }, steps: { type: 'array', items: STEP_SCHEMA } } },
          },
          next: { type: 'boolean', description: 'Active step finished, start the next one' },
          done: { type: 'array', items: { type: 'string' }, description: 'Step titles now finished' },
          active: { type: 'string', description: 'Step title now in progress' },
          failed: { type: 'string', description: 'Step title that failed' },
          state: { enum: ['running', 'needs_input', 'error', 'done'] },
          note: { type: 'string', description: 'One line for needs_input or error' },
        },
      },
    })
    // a session reopened later (an app restart, a resume) finds its bars where it left them
    if ((await read($, plans)).length === 0) await restore($)
    const own = await $.session.usage()
    const shared = readingOf(await $.store.get(LIMITS_KEY))
    const limits = limitsOf(own.rateLimits)
    const now = await $.clock.now()
    const merged = new Map((shared?.limits ?? []).map(l => [l.kind, l]))
    for (const limit of limits) {
      const previous = merged.get(limit.kind)
      const reset = Date.parse(limit.resetsAt ?? '')
      const sharedReset = Date.parse(previous?.resetsAt ?? '')
      // session.usage is the last API response, which can predate a shared window.
      if (previous && sharedReset > now && (sharedReset > reset || (sharedReset === reset && previous.percentUsed > limit.percentUsed))) continue
      merged.set(limit.kind, limit)
    }
    const reading = limits.length > 0 ? { limits: [...merged.values()], at: now } : shared
    if (limits.length > 0) await $.store.set(LIMITS_KEY, reading)
    await update($, usage, u => ({ ...u, contextPercent: own.context.percent ?? null, limits: reading?.limits ?? [], at: reading?.at ?? 0 }))
    await refreshTokens($)
    timers = [
      // other sessions' readings and tokens, and the reset countdowns
      $.clock.every(60_000, async () => {
        await refreshLimits($)
        await refreshTokens($)
        $.ui.invalidate('ui.render')
      }),
      // the desktop's clocks and effects move inside its drawings; the terminal draws times as text
      $.clock.every(1000, async () => {
        if (band?.surface !== 'terminal') return
        if (band.isWorking || (await read($, plans)).some(p => (p.agents ?? []).some(isLive))) $.ui.invalidate('ui.render')
      }),
    ]

    return next(e)
  })

  // /resume and /clear switch to another session id: show that session's bars, and its context
  on('classic.SessionStart', { source: ['resume', 'clear'] }, async ($, e, next) => {
    await restore($)
    const own = await $.session.usage()
    await update($, usage, u => ({ ...u, contextPercent: own.context.percent ?? null }))

    return next(e)
  })

  // after each turn, and when a rate-limit window moves a whole point
  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    const hasLimits = e.changed.includes('rateLimits')
    // ponytail: last writer wins on the shared key; a slow session can briefly put back an older reading
    if (hasLimits) await $.store.set(LIMITS_KEY, { at: now, limits: e.rateLimits })
    await update($, usage, u => ({
      ...u,
      contextPercent: e.context.percent ?? null,
      limits: hasLimits ? [...e.rateLimits] : u.limits,
      at: hasLimits ? now : u.at,
    }))

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)

    return { sections: [...result.sections, { id: 'progress-band:rules', text: RULES, scope: 'session' as const }] }
  })

  on('turn.start', async ($, e, next) => {
    workCalls = 0
    isPlanTouched = false
    isWaitingOnBackground = false
    isQuotaStop = false
    mainTools = 0
    await update($, activity, a => ({ ...a, state: 'thinking' as const, tool: null }))

    return next(e)
  })

  // the person answering clears any "needs input"; open bars ride along as one short line, so the model
  // keeps their ids past a compaction
  on('prompt.submit', async ($, e, next) => {
    if (!PERSON.has(e.origin.kind)) return next(e)
    const all = await read($, plans)
    if (all.some(p => p.state === 'needs_input')) {
      await editBars($, bars => bars.map(p => (p.state === 'needs_input' ? { ...p, state: 'running' as const, note: null } : p)))
    }
    const open = all.filter(p => p.state !== 'done')
    if (open.length === 0) return next(e)
    const line = `progress-band open bars: ${open
      .map(p => {
        const w = where(p)
        return `${p.id} (${p.stages[w.stage]?.name ?? ''} ${w.step}/${w.stageSize})`
      })
      .join(', ')}`

    return next({ ...e, context: [...(e.context ?? []), line] })
  })

  // a subagent's call names its current tool on its row; the main loop's edits count as work
  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      const agentId = e.agentId
      if (!agentHome.has(agentId)) return next(e)
      await editAgent($, agentId, a => ({ ...a, state: 'running', tool: e.tool }))
      if (e.tool_use_id) toolUses.set(e.tool_use_id, agentId)
      let ran
      try {
        ran = await next(e)
      } finally {
        if (e.tool_use_id) toolUses.delete(e.tool_use_id)
      }
      if (waiting.delete(agentId)) await editAgent($, agentId, a => (a.state === 'waiting' ? { ...a, state: 'running' } : a))
      return ran
    }
    if (SHELL_TOOLS.has(e.tool)) isWaitingOnBackground = (e as unknown as Raw).run_in_background === true
    if (EDIT_TOOLS.has(e.tool)) {
      isWaitingOnBackground = false
      workCalls += 1
    }
    // the strip names the tool the main conversation runs inside a turn; parallel calls show the latest until
    // all end. A call outside any turn (another plugin's) leaves the strip as it is
    if ((await read($, activity)).state === 'idle') return next(e)
    mainTools += 1
    await update($, activity, a => ({ ...a, state: 'tool' as const, tool: toolLabel(e.tool) }))
    let ran
    try {
      ran = await next(e)
    } finally {
      mainTools = Math.max(0, mainTools - 1)
      if (mainTools === 0) await update($, activity, a => (a.state === 'tool' ? { ...a, state: 'thinking' as const, tool: null } : a))
    }
    // past the person's stop line, the result tells Claude to wrap up at a clean point and wait for them; once
    // per window, so their next instruction carries on undisturbed
    const five = (await read($, usage)).limits.find(l => l.kind === 'five_hour')
    const isOpenWindow = !five?.resetsAt || Date.parse(five.resetsAt) > (await $.clock.now())
    if (!five || five.percentUsed < QUOTA_STOP || !isOpenWindow || quotaWarned === (five.resetsAt ?? 'open') || ran.deny !== undefined || ran.isError) return ran
    quotaWarned = five.resetsAt ?? 'open'
    isQuotaStop = true

    return {
      ...ran,
      context: [
        ...(ran.context ?? []),
        `progress-band: the 5-hour usage limit is at ${Math.round(five.percentUsed)}%, past the user's stop line of ${QUOTA_STOP}%. Finish the current step at a clean point, say briefly what is done and what is left, then stop and wait for the user's next instruction.`,
      ],
    }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const raw = e as unknown as Raw
    const now = await $.clock.now()
    const id = slug(str(raw.id, 60) || str(raw.title, 80))
    const made = await editPlan($, id, prev => {
      const plan = normalize(raw, prev, now, id)
      return typeof plan !== 'string' && plan.stages.length === 0 ? `plan_progress: no bar "${id}" yet; create it with title and stages.` : plan
    })
    if (typeof made === 'string') return { deny: made }
    isPlanTouched = true
    const w = where(made)
    const active = made.state === 'done' ? undefined : made.stages.flatMap(st => st.steps).find(st => st.status === 'active')
    // the agents on the bar as stored, so the model sees which of its agents the bar tracks
    const runs = (await read($, plans)).find(p => p.id === id)?.agents ?? []
    const agents = runs.length ? `, agents ${runs.filter(isLive).length} running of ${runs.length}` : ''

    return { result: `${id}: ${Math.min(w.pos, w.total)}/${w.total}, ${made.state}${active ? `, active "${active.title}"` : ''}${agents}` }
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    // a subagent's question goes to Claude, not to the person
    if (e.agentId) return next(e)
    const live = focusOf(await read($, plans))
    if (live) await editBars($, all => all.map(p => (p.id === live.id ? { ...p, state: 'needs_input' as const } : p)))
    const ran = await next(e)
    if (live) await editBars($, all => all.map(p => (p.id === live.id && p.state === 'needs_input' ? { ...p, state: 'running' as const } : p)))

    return ran
  })

  // an open bar at the end of a turn: a question to the person marks it waiting on its own;
  // only a turn that did work and left the bar unexplained is sent back, once
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (e.stop_hook_active || result.block || isWaitingOnBackground || (e.background_tasks?.length ?? 0) > 0) return result
    const open = (await read($, plans)).filter(isOpenPlan)
    const last = focusOf(open)
    if (!last) return result
    // stopped at the person's 5-hour line: the bar waits for them, saying why
    if (isQuotaStop) {
      isQuotaStop = false
      await editBars($, all => all.map(p => (p.id === last.id ? { ...p, state: 'needs_input' as const, note: `5小时额度已过 ${QUOTA_STOP}%，等你的下一个指令` } : p)))
      return result
    }
    if (/[?？]\s*$/.test(e.last_assistant_message ?? '')) {
      await editBars($, all => all.map(p => (p.id === last.id ? { ...p, state: 'needs_input' as const } : p)))
      return result
    }
    if (workCalls === 0 && !isPlanTouched) return result

    return {
      ...result,
      block: `progress-band: ${open.map(p => p.id).join(', ')} still open. Update each with ${TOOL}: {id, next:true}, or state "done", "needs_input" or "error" with a note.`,
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const all = await read($, plans)
    const parentHome = e.parentAgentId ? agentHome.get(e.parentAgentId) : undefined
    const home = parentHome && all.some(p => p.id === parentHome) ? parentHome : focusOf(all.filter(isOpenPlan))?.id
    const startedAt = await $.clock.now()
    const started = await next(e)
    if (!started.agentId) return started
    const id = started.agentId
    // ponytail: an agent started with no open bar is not drawn; give it a bar of its own if that is wanted
    if (!home) return started
    const run: AgentRun = {
      id,
      title: str(e.description || e.subagentType, 60),
      state: 'running',
      tool: '启动中',
      model: started.model,
      startedAt,
      endedAt: null,
      depth: parentHome ? 1 : 0,
    }
    await update($, plans, all => all.map(p => (p.id === home ? addRun(p, run, e.parentAgentId) : p)))
    agentHome.set(id, home)

    return started
  })

  // an agent waiting on a permission prompt breathes in amber until the call goes on
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const useId = e.tool_use_id
    const agentId = useId ? toolUses.get(useId) : undefined
    // the mode often settles an ask by itself in a blink; only a call still held after a moment waits on the person
    if (agentId && useId && verdict.decision === 'ask') {
      $.clock.after(600, async () => {
        if (toolUses.get(useId) !== agentId) return
        waiting.add(agentId)
        await editAgent($, agentId, a => ({ ...a, state: 'waiting', tool: '待批准' }))
      })
    }

    return verdict
  })

  // the first request of an agent's loop says what it runs on: the resolved model and its effort
  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    if (agentId && agentHome.has(agentId)) {
      const effort = e.effort === undefined ? undefined : String(e.effort)
      const known = (await read($, plans)).flatMap(p => p.agents ?? []).find(a => a.id === agentId)
      if (known && (known.model !== e.model || known.effort !== effort)) await editAgent($, agentId, a => ({ ...a, model: e.model, effort }))
    }
    const result = yield* next(e)
    // every request reports its own tokens as it ends, the main loop's and each agent's, so the week's
    // count moves while a turn runs rather than after it; awaited (a few store calls), so the count shown
    // is current before the loop moves on
    if (result.usage) await countTokens($, countsOf(result.usage))

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    const now = await $.clock.now()
    if (agentId && agentHome.has(agentId)) {
      const isFailed = e.reason !== 'answer'
      const tool = e.reason === 'aborted' ? '已停止' : isFailed ? '失败' : '完成'
      await editAgent($, agentId, a => ({ ...a, state: isFailed ? 'error' : 'done', tool, endedAt: now }))
      agentHome.delete(agentId)
      waiting.delete(agentId)
    }
    // the main conversation's turn ended: the strip goes idle
    if (!agentId) {
      mainTools = 0
      await update($, activity, a => ({ ...a, state: 'idle' as const, tool: null }))
    }
    // a plan whose steps are all finished closes itself
    const isFinishedPlan = (p: Plan) => p.state !== 'done' && p.stages.flatMap(s => s.steps).every(s => isFinished(s.status)) && p.stages.length > 0
    if ((await read($, plans)).some(isFinishedPlan)) {
      await editBars($, all => all.map(p => (isFinishedPlan(p) ? { ...p, state: 'done' as const, endedAt: now } : p)))
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const t = $.ui.resolve(e)
    const { Box, Button, Text } = t
    // the terminal's table has an Svg too, drawn as nothing there
    const Svg = e.surface !== 'terminal' && 'Svg' in t ? t.Svg : null
    const u = await read($, usage)
    const all = await read($, plans)
    const now = await $.clock.now()
    band = { surface: e.surface, isWorking: e.props.isWorking }
    const cols = Math.max(30, e.props.bodyColumns || 100)
    const meters = metersOf(u, now)
    const tokens = u.tokens && tokenSum(u.tokens) > 0 ? u.tokens : null
    const budget = childBudget(all.length)
    // drawing memory of bars no longer listed (closed, or pushed out past MAX_BARS) goes
    for (const id of lastHead.keys()) if (!all.some(p => p.id === id)) lastHead.delete(id)
    for (const key of lastSource.keys()) if (!all.some(p => key.startsWith(`${p.id}/`))) lastSource.delete(key)

    // what the main conversation does now, leading the meters' row
    const act = await read($, activity)
    const ses = await read($, session)
    const isBusy = e.props.isWorking || act.state !== 'idle'
    const doing = act.state === 'tool' ? (act.tool ?? '工具') : isBusy ? '思考中' : '空闲'

    // this session's tokens and the week's in one item after the weekly meter; on the desktop a small Sankey
    // leads it and hovering opens the full one. The app draws that card in its own theme, so the card forces
    // no colour: forced light text was unreadable on its light card
    const tokenNode = () =>
      tokens ? (
        <Box key="tokens" flexDirection="row" columnGap={1} alignItems="center">
          {Svg ? <Svg source={sankeySvg(tokens, ses.tokens, isBusy, false)} alt={sankeyAlt(tokens, ses.tokens)} width={SANKEY_ICON_W} height={SANKEY_ICON_H} /> : null}
          <Text dimColor>{`${Svg ? '' : '· '}${compact(Math.min(ses.tokens, tokenSum(tokens)))} / ${compact(tokenSum(tokens))} tokens`}</Text>
          {Svg ? (
            <Box position="absolute" top={1} right={0} display="none" hover={{ display: 'flex' }} flexDirection="column" paddingX={1}>
              <Text bold>本会话 / 本周 token · 本机会话</Text>
              <Svg source={sankeySvg(tokens, ses.tokens, isBusy, true)} alt={sankeyAlt(tokens, ses.tokens)} width={SANKEY_W} height={SANKEY_H} />
            </Box>
          ) : null}
        </Box>
      ) : null

    // the tree glyph before each row that hangs from a task
    const branch = (isLast: boolean) => <Text dimColor>{isLast ? '└' : '├'}</Text>

    let meterRow: RenderChildren = null
    let bars: RenderChildren[] = []

    if (Svg) {
      // every track has the same width and is pinned to the right edge (fixed-width percent, close button),
      // so rows line up whatever their titles; the desktop reports ~8 CSS px per column, draws text at ~14 px,
      // and pads the band, so the room left for the icon, percent, close button and gaps includes that padding
      const total = Math.max(320, cols * 8)
      const titlePx = Math.min(Math.round(total * 0.3), Math.max(48, ...all.map(p => Math.round(textWidth(p.title, 14)))))
      const trackW = Math.max(120, Math.min(1400, total - titlePx - 144))
      meterRow = (
        <Box key="meters" flexDirection="row" columnGap={3} alignItems="center" flexWrap="wrap">
          <Box key="doing" flexDirection="row" columnGap={1} alignItems="center">
            <Svg source={isBusy ? stateIcon('running', true) : IDLE_ICON} alt={doing} width={ICON} height={ICON} />
            <Text color={isBusy ? STATE_COLOR.running : undefined} dimColor={!isBusy}>
              {doing}
            </Text>
          </Box>
          {meters.map(m => {
            const color = m.used === null ? undefined : STATE_COLOR[levelOf(m.used)]
            return (
              <Box key={`meter-${m.key}`} flexDirection="row" columnGap={1} alignItems="center">
                <Text dimColor>{m.label}</Text>
                <Svg source={meterSvg(m)} alt={`${m.label} ${meterValue(m)}`} width={METER_W} height={METER_SVG_H} />
                <Text color={color} dimColor={color === undefined} bold>
                  {meterValue(m)}
                </Text>
                {m.resetIn ? <Text dimColor>{`↻ ${m.resetIn}${m.resetAt ? ` · ${m.resetAt}` : ''}`}</Text> : null}
                {m.key === 'seven_day' ? tokenNode() : null}
              </Box>
            )
          })}
        </Box>
      )
      // live traffic per bar: the main turn works on the running bar the model moved last, each running agent on its own bar
      const focus = focusOf(all)?.id
      bars = all.map(p => {
        const traffic = (e.props.isWorking && p.id === focus ? 1 : 0) + (p.agents ?? []).filter(isLive).length
        const track = trackSvg(p, trackW, traffic)
        const v = visibleAgents(p, Math.max(1, budget - (p.note && p.state !== 'running' ? 1 : 0)))
        const rows: RenderChildren[] = []
        const hidden = v?.hidden ?? []
        const shown = v?.shown ?? []
        const hasNote = Boolean(p.note) && p.state !== 'running'
        const total = (hasNote ? 1 : 0) + shown.length + (hidden.length > 0 ? 1 : 0)
        let n = 0
        if (hasNote) {
          n += 1
          rows.push(
            <Box key={`note-${p.id}`} flexDirection="row" gap={1} marginLeft={1}>
              {branch(n === total)}
              <Text color={STATE_COLOR[p.state]} wrap="truncate">
                {p.note}
              </Text>
            </Box>,
          )
        }
        for (const a of shown) {
          n += 1
          const state = AGENT_STATE[a.state]
          const spec = agentSpec(a)
          rows.push(
            <Box key={`agent-${a.id}`} flexDirection="row" alignItems="center" gap={1} marginLeft={1}>
              {branch(n === total)}
              <Svg source={stateIcon(state)} alt={STATE_NAME[state]} width={ICON} height={ICON} />
              <Text wrap="truncate" dimColor={a.state === 'done'}>
                {a.title}
              </Text>
              {spec ? <Text dimColor>{spec}</Text> : null}
              <Box flexGrow={1} />
              {isLive(a) ? <Text color={STATE_COLOR[state]}>{a.tool}</Text> : null}
              {a.endedAt === null ? (
                <Svg source={liveSource(`${p.id}/${a.id}`, agentClock(a.startedAt), now)} alt={`已运行 ${elapsed(now - a.startedAt)}`} width={CLOCK_W} height={REEL} />
              ) : (
                <Text dimColor>{elapsed(a.endedAt - a.startedAt)}</Text>
              )}
            </Box>,
          )
        }
        if (hidden.length > 0) {
          rows.push(
            <Box key={`more-${p.id}`} flexDirection="row" gap={1} marginLeft={1}>
              {branch(true)}
              <Text dimColor>{`还有 ${hidden.length} 个子代理 · ${hidden.filter(a => a.state === 'done').length} 个已完成`}</Text>
            </Box>,
          )
        }

        return (
          <Box key={`bar-${p.id}`} flexDirection="column">
            <Box flexDirection="row" alignItems="center" gap={1}>
              <Svg source={stateIcon(p.state, traffic > 0)} alt={STATE_NAME[p.state]} width={ICON} height={ICON} />
              <Text wrap="truncate" dimColor={p.state === 'done'}>
                {p.title}
              </Text>
              <Box flexGrow={1} />
              <Box key={`track-${p.id}`} flexShrink={0}>
                <Svg source={track.base} alt={rowAlt(p)} width={trackW} height={ROW_H} />
                <Box position="absolute" top={0} left={0}>
                  {/* the hover layer is rebuilt on every redraw anyway, so its clock is set from now each time */}
                  <Svg source={withTime(track.overlay, now)} alt={`${p.title}：悬停查看时间`} width={trackW} height={ROW_H} isInteractive />
                </Box>
              </Box>
              <Text color={p.state === 'done' ? STATE_COLOR.done : undefined} dimColor={p.state !== 'done'}>
                {`${String(percentOf(p)).padStart(3, FIGURE_SPACE)}%`}
              </Text>
              <Button key={`close-${p.id}`} plain dimColor label="✕" onPress={() => dropPlan($, p.id)} />
            </Box>
            {rows}
          </Box>
        )
      })
    } else {
      // the meters as segment bars when the row fits, then a text bar per task with its agents under it
      const rowCells =
        meters.reduce((sum, m) => sum + cellsOf(m.label) + 12 + meterValue(m).length + (m.resetIn ? 2 + m.resetIn.length + (m.resetAt ? 8 : 0) : 0), 0) +
        3 * (meters.length - 1) +
        (tokens ? 24 : 0) +
        cellsOf(doing) + 5
      const hasSegments = rowCells <= cols - 2
      meterRow = (
        <Box key="meters" flexDirection="row" columnGap={3} flexWrap="wrap">
          <Text color={isBusy ? STATE_COLOR.running : undefined} dimColor={!isBusy}>{`${isBusy ? '●' : '○'} ${doing}`}</Text>
          {meters.map(m => {
            const color = m.used === null ? undefined : STATE_COLOR[levelOf(m.used)]
            const lit = Math.round((Math.min(100, Math.max(0, m.used ?? 0)) / 100) * METER_CELLS)
            return (
              <Box key={`meter-${m.key}`} flexDirection="row" columnGap={1}>
                <Text dimColor>{m.label}</Text>
                {hasSegments ? (
                  <Text>
                    <Text color={color} dimColor={color === undefined}>
                      {'▰'.repeat(lit)}
                    </Text>
                    <Text dimColor>{'▱'.repeat(METER_CELLS - lit)}</Text>
                  </Text>
                ) : null}
                <Text color={color} dimColor={color === undefined}>
                  {meterValue(m)}
                </Text>
                {m.resetIn ? <Text dimColor>{`${m.resetIn}${m.resetAt ? ` (${m.resetAt})` : ''}`}</Text> : null}
                {m.key === 'seven_day' ? tokenNode() : null}
              </Box>
            )
          })}
        </Box>
      )
      const titleW = Math.max(4, Math.min(Math.round(cols * 0.25), Math.max(0, ...all.map(p => cellsOf(p.title)))))
      const trackW = Math.max(10, Math.min(60, Math.round(cols * 0.35)))
      bars = all.map(p => {
        const w = where(p)
        const color = STATE_COLOR[p.state]
        const bar = barText(p, trackW)
        // no hover on the terminal: the label carries the stage, the step and the time
        const label =
          p.state === 'done'
            ? `完成 · ${p.endedAt ? elapsed(p.endedAt - p.startedAt) : ''}`
            : `${p.stages[w.stage]?.name ?? ''} ${w.step}/${w.stageSize} · ${elapsed(now - p.startedAt)}`
        const v = visibleAgents(p, budget)

        return (
          <Box key={`bar-${p.id}`} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={color}>{STATE_GLYPH[p.state]}</Text>
              <Box width={titleW} flexShrink={0}>
                <Text wrap="truncate">{p.title}</Text>
              </Box>
              <Text>
                <Text color={color}>{bar.done}</Text>
                <Text dimColor>{bar.rest}</Text>
              </Text>
              <Box flexGrow={1}>
                <Text color={color} wrap="truncate">
                  {label}
                </Text>
              </Box>
              <Text dimColor>{`${String(percentOf(p)).padStart(3, FIGURE_SPACE)}%`}</Text>
              <Button key={`close-${p.id}`} plain dimColor label="✕" onPress={() => dropPlan($, p.id)} />
            </Box>
            {p.note && p.state !== 'running' ? (
              <Box marginLeft={2}>
                <Text color={color} wrap="truncate">{`└ ${p.note}`}</Text>
              </Box>
            ) : null}
            {(v?.shown ?? []).map((a, i) => {
              const spec = agentSpec(a)
              const state = AGENT_STATE[a.state]
              const isLast = i === (v?.shown.length ?? 0) - 1 && (v?.hidden.length ?? 0) === 0
              return (
                <Box key={`agent-${a.id}`} flexDirection="row" gap={1} marginLeft={2}>
                  {branch(isLast)}
                  <Text color={STATE_COLOR[state]}>{STATE_GLYPH[state]}</Text>
                  <Box flexGrow={1}>
                    <Text wrap="truncate">
                      {a.title}
                      <Text dimColor>{spec ? ` ${spec}` : ''}</Text>
                    </Text>
                  </Box>
                  {isLive(a) ? <Text color={STATE_COLOR[state]}>{a.tool}</Text> : null}
                  <Text dimColor>{elapsed((a.endedAt ?? now) - a.startedAt)}</Text>
                </Box>
              )
            })}
            {v && v.hidden.length > 0 ? (
              <Box marginLeft={2}>
                <Text dimColor>{`└ 还有 ${v.hidden.length} 个子代理 · ${v.hidden.filter(a => a.state === 'done').length} 个已完成`}</Text>
              </Box>
            ) : null}
          </Box>
        )
      })
    }

    const mine = (
      <Box flexDirection="column" gap={Svg && all.length > 0 ? 1 : 0}>
        <Box key="head" flexDirection="column">
          {meterRow}
        </Box>
        {bars}
      </Box>
    )
    // keep what the mods beneath this one draw in the band
    const rest = await next(e)
    if (!rest) return mine

    return (
      <Box flexDirection="column">
        {mine}
        {rest}
      </Box>
    )
  })
}
