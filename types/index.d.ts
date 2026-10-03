export type StepStatus = 'pending' | 'active' | 'done' | 'error' | 'skipped'
// doneAt: when the step was finished, for the time its checkpoint shows
export type PlanStep = { title: string; status: StepStatus; doneAt?: number }
export type PlanStage = { name: string; steps: PlanStep[] }
export type PlanState = 'running' | 'needs_input' | 'error' | 'done'
// one subagent, drawn as a row under its task's bar; depth 1 sits under its parent agent
export type AgentRun = {
  id: string
  title: string
  state: 'running' | 'waiting' | 'done' | 'error'
  tool: string
  startedAt: number
  endedAt: number | null
  depth: number
  // the model it runs on and its effort, as the engine resolved them
  model?: string
  effort?: string
}
export type Plan = {
  id: string
  title: string
  stages: PlanStage[]
  state: PlanState
  note: string | null
  startedAt: number
  // when the plan was finished; the pill then shows the time it took
  endedAt?: number | null
  // when the model last moved this bar: of the running bars, the one it touched last is the one it works on
  touchedAt?: number
  agents?: AgentRun[]
}
// one rate-limit window as the engine reports it
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
// input, output, cache write, cache read
export type TokenCounts = [number, number, number, number]
export type Usage = {
  contextPercent: number | null
  limits: Limit[]
  // when limits were read, in $.clock.now() milliseconds
  at: number
  // tokens this machine's sessions used inside the weekly window; null before the first count
  tokens: TokenCounts | null
}
// what the main conversation does right now: a model request, a tool, or nothing
export type Activity = { state: 'idle' | 'thinking' | 'tool'; tool: string | null }
// the tokens this session used
export type Session = { tokens: number }

declare module 'claude-code' {
  interface PluginState {
    'progress-band': {
      plans: Plan[]
      usage: Usage
      activity: Activity
      session: Session
    }
  }
}
