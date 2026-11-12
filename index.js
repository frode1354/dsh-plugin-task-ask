/**
 * Host side of the task-ask plugin.
 *
 * Maintains a live, read-only view of each session (events + transient
 * assistant stream), and answers questions through a one-shot
 * `llm.stream` call that never writes to the session log and never calls
 * followup / steer / prompt.
 *
 * Important: HTTP handlers capture service *instances* at `apply()` time.
 * Re-resolving `ctx.sessions` / `ctx.agents` inside the webServer callback
 * can throw ("inactive context") and the host then answers with an empty
 * 400 — which breaks `response.json()` on the client.
 *
 * @module dsh-plugin-task-ask
 */

import { createReadStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'task-ask'
export const inject = ['webServer', 'sessions', 'llm', 'agents']

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(__dirname, 'public')
const MAX_HISTORY_CHARS = 20_000
const MAX_OPEN_TURN_CHARS = 28_000
const MAX_LIVE_CHARS = 32_000
const MAX_ANSWER_TOKENS = 2_048
const ASK_TIMEOUT_MS = 120_000
const MAX_TOOL_ROUNDS = 6
const MAX_TOOL_EVENTS = 8

/** @typedef {{ content: string, status: string }} TodoItem */
/** @typedef {{
 *   name: string,
 *   kind: 'call' | 'result',
 *   preview: string,
 *   isError?: boolean,
 * }} ToolEventItem */
/** @typedef {{
 *   sessionId: string,
 *   title: string,
 *   agentStatus: 'idle' | 'running' | 'unknown',
 *   phase: string,
 *   phaseDetail: string,
 *   turn: number | null,
 *   step: number | null,
 *   todos: TodoItem[],
 *   todosDone: TodoItem[],
 *   planComplete: boolean,
 *   recentTools: string[],
 *   toolEvents: ToolEventItem[],
 *   historyText: string,
 *   openTurnText: string,
 *   liveText: string,
 *   eventCount: number,
 *   updatedAt: number,
 * }} TaskSnapshot */
/** @typedef {{
 *   liveText: string,
 *   liveReasoning: string,
 *   listeners: Set<(s: TaskSnapshot | null) => void>,
 * }} LiveEntry */

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // Pin service handles while this fiber is active — do not re-enter
  // `ctx.sessions` / `ctx.agents` / `ctx.llm` from async HTTP callbacks.
  const webServer = ctx.webServer
  const sessions = ctx.sessions
  const agents = ctx.agents
  const llm = ctx.llm
  // Pin optional default-model service at apply() — same inactive-context
  // hazard as sessions/agents if resolved later from HTTP callbacks.
  let agentDefaultModel = null
  try { agentDefaultModel = ctx.get('agentDefaultModel') } catch { /* optional */ }
  const getDefaultModel = () => {
    try {
      return agentDefaultModel?.currentSelection?.()
    } catch {
      return undefined
    }
  }

  // Optional tools service — sidecar may call tools without writing the main session.
  let tools = null
  for (const key of ['tools', 'toolRegistry', 'agentTools']) {
    try {
      const svc = ctx.get(key)
      if (svc) { tools = svc; break }
    } catch { /* optional */ }
  }

  /** @type {Map<string, LiveEntry>} */
  const live = new Map()

  const getLive = (sessionId) => {
    let entry = live.get(sessionId)
    if (!entry) {
      entry = { liveText: '', liveReasoning: '', listeners: new Set() }
      live.set(sessionId, entry)
    }
    return entry
  }

  /** Drop buffers for sessions that no longer exist / have no SSE listeners. */
  const pruneLive = () => {
    for (const [id, entry] of live) {
      let exists = false
      try { exists = Boolean(sessions.get(/** @type {any} */ (id))) } catch { exists = false }
      if (!exists && entry.listeners.size === 0) {
        live.delete(id)
      }
    }
  }

  const publish = (sessionId) => {
    let snap = null
    try {
      // SSE / UI status only needs a lite snapshot — full historyText can be
      // hundreds of KB and breaks EventSource on the client.
      snap = buildSnapshot(sessions, agents, sessionId, getLive(sessionId), { lite: true })
    } catch {
      return
    }
    const entry = live.get(sessionId)
    if (!entry) return
    for (const listener of entry.listeners) {
      try { listener(snap) } catch { /* isolated */ }
    }
  }

  // Release per-session buffers when the session is torn down.
  ctx.on('session/disposed', (session) => {
    live.delete(String(session.id))
  })

  // Durable log updates. Do NOT wipe the live stream on every event — tool
  // calls mid-turn would erase the unfinished assistant reply the user wants
  // the sidecar to read. Only clear transient buffers when the attempt settles
  // or the turn closes / restarts.
  ctx.on('session/event', (session) => {
    const id = String(session.id)
    const entry = getLive(id)
    try {
      const events = session.snapshotEvents()
      const last = events[events.length - 1]
      const type = last?.type
      if (type === 'turn/start' || type === 'turn/end'
        || type === 'assistant/message' || type === 'assistant/attempt') {
        entry.liveText = ''
        entry.liveReasoning = ''
      }
    } catch { /* ignore */ }
    publish(id)
  })

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const id = String(agent.sessionId)
    const entry = getLive(id)
    if (frame?.type === 'chunk' && frame.chunk) {
      const chunk = frame.chunk
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        entry.liveText = truncate(`${entry.liveText}${chunk.text}`, MAX_LIVE_CHARS)
      } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        entry.liveReasoning = truncate(`${entry.liveReasoning}${chunk.text}`, MAX_LIVE_CHARS)
      }
    } else if (frame?.type === 'end' || frame?.type === 'error') {
      // Keep buffers until the matching durable assistant/* event arrives.
    }
    publish(id)
  })

  ctx.on('agent/status', ({ agent }) => {
    publish(String(agent.sessionId))
  })

  const safe = (handler) => async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      if (res.headersSent) {
        try { res.destroy() } catch { /* ignore */ }
        return
      }
      json(res, {
        error: error instanceof Error ? error.message : String(error),
      }, 500)
    }
  }

  webServer.register({
    kind: 'exact',
    path: '/task-ask',
    handler: (_req, res) => sendFile(res, join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8'),
  })
  webServer.register({
    kind: 'exact',
    path: '/task-ask/',
    handler: (_req, res) => {
      res.statusCode = 302
      res.setHeader('Location', '/task-ask')
      res.end()
    },
  })
  webServer.register({
    kind: 'prefix',
    path: '/task-ask/assets',
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const rel = url.pathname.slice('/task-ask/assets'.length).replace(/^\/+/, '')
      if (!rel || rel.includes('..') || rel.includes('\\')) {
        res.statusCode = 404
        res.end('not found')
        return
      }
      const file = join(PUBLIC_DIR, rel)
      const type = rel.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : rel.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : 'application/octet-stream'
      sendFile(res, file, type)
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/api/task-ask/sessions',
    handler: safe((_req, res) => {
      pruneLive()
      const list = sessions.list()
      const out = []
      for (const session of list) {
        try {
          const id = String(session.id)
          let agentStatus = 'unknown'
          try {
            agentStatus = agents.get(session.id)?.status ?? 'unknown'
          } catch { /* ignore */ }
          out.push({
            id,
            title: safeTitle(session) ?? id.slice(0, 8),
            agentStatus,
            eventCount: Number(session.seq) || 0,
          })
        } catch {
          /* skip broken session */
        }
      }
      json(res, { sessions: out })
    }),
  })

  webServer.register({
    kind: 'exact',
    path: '/api/task-ask/snapshot',
    handler: safe((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) {
        json(res, { error: 'sessionId required' }, 400)
        return
      }
      const lite = url.searchParams.get('lite') === '1'
      const snap = buildSnapshot(
        sessions,
        agents,
        sessionId,
        getLive(sessionId),
        { lite },
      )
      if (!snap) {
        json(res, { error: 'session not found' }, 404)
        return
      }
      json(res, snap)
    }),
  })

  webServer.register({
    kind: 'exact',
    path: '/api/task-ask/events',
    handler: safe((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) {
        json(res, { error: 'sessionId required' }, 400)
        return
      }
      if (!sessions.get(/** @type {any} */ (sessionId))) {
        json(res, { error: 'session not found' }, 404)
        return
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      })
      res.write(': connected\n\n')

      const send = (snap) => {
        if (!snap) return
        res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`)
      }
      const entry = getLive(sessionId)
      entry.listeners.add(send)
      send(buildSnapshot(sessions, agents, sessionId, entry, { lite: true }))

      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n') } catch { /* closed */ }
      }, 15_000)

      const cleanup = () => {
        clearInterval(heartbeat)
        entry.listeners.delete(send)
        if (entry.listeners.size === 0) {
          let exists = false
          try { exists = Boolean(sessions.get(/** @type {any} */ (sessionId))) } catch { /* ignore */ }
          if (!exists) live.delete(sessionId)
        }
      }
      req.on('close', cleanup)
      req.on('aborted', cleanup)
    }),
  })

  webServer.register({
    kind: 'exact',
    path: '/api/task-ask/ask',
    handler: safe(async (req, res) => {
      if (req.method !== 'POST') {
        json(res, { error: 'POST required' }, 405)
        return
      }
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        json(res, { error: 'invalid JSON body' }, 400)
        return
      }
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      const question = typeof body.question === 'string' ? body.question.trim() : ''
      if (!sessionId || !question) {
        json(res, { error: 'sessionId and question are required' }, 400)
        return
      }

      const snap = buildSnapshot(sessions, agents, sessionId, getLive(sessionId), { lite: false })
      if (!snap) {
        json(res, { error: 'session not found' }, 404)
        return
      }

      const wantStream = body.stream === true
        || String(req.headers.accept || '').includes('text/event-stream')
      const wantTools = body.tools !== false

      if (!wantStream) {
        try {
          const answer = await answerQuestion(llm, sessions, getDefaultModel, snap, question, {
            tools: wantTools ? tools : null,
          })
          json(res, {
            answer,
            interrupted: false,
            mode: 'sidecar',
            snapshotAt: snap.updatedAt,
          })
        } catch (error) {
          json(res, {
            error: error instanceof Error ? error.message : String(error),
          }, 500)
        }
        return
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      })
      const writeEvent = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      writeEvent('meta', {
        snapshotAt: snap.updatedAt,
        mode: 'sidecar',
        tools: Boolean(wantTools && tools),
      })

      const ac = new AbortController()
      const onClose = () => ac.abort()
      req.on('close', onClose)
      req.on('aborted', onClose)

      try {
        let produced = false
        for await (const piece of streamAnswer(llm, sessions, getDefaultModel, snap, question, ac.signal, {
          tools: wantTools ? tools : null,
        })) {
          if (typeof piece === 'string') {
            produced = true
            writeEvent('delta', { text: piece })
          } else if (piece && piece.kind === 'text' && piece.text) {
            produced = true
            writeEvent('delta', { text: piece.text })
          } else if (piece && piece.kind === 'tool') {
            writeEvent('tool', piece)
          }
        }
        if (!produced) throw new Error('模型未返回文本')
        writeEvent('done', { interrupted: false })
      } catch (error) {
        if (!ac.signal.aborted) {
          writeEvent('error', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      } finally {
        req.off('close', onClose)
        req.off('aborted', onClose)
        try { res.end() } catch { /* ignore */ }
      }
    }),
  })
}

/**
 * @param {any} sessions
 * @param {any} agents
 * @param {string} sessionId
 * @param {LiveEntry | { liveText?: string, liveReasoning?: string }} liveEntry
 * @param {{ lite?: boolean }} [opts]
 * @returns {TaskSnapshot | null}
 */
function buildSnapshot(sessions, agents, sessionId, liveEntry, opts = {}) {
  const session = sessions.get(/** @type {any} */ (sessionId))
  if (!session) return null

  const liveText = liveEntry?.liveText || ''
  const liveReasoning = liveEntry?.liveReasoning || ''

  let events = []
  try { events = session.snapshotEvents() } catch { events = [] }

  let agentStatus = 'unknown'
  try { agentStatus = agents.get(session.id)?.status ?? 'unknown' } catch { /* ignore */ }

  let todosAll = []
  try { todosAll = latestTodos(events) } catch { todosAll = [] }
  const todosActive = todosAll.filter((t) => t.status !== 'completed')
  const todosDone = todosAll.filter((t) => t.status === 'completed')
  const planComplete = todosAll.length > 0 && todosActive.length === 0

  const phase = inferPhase(events, agentStatus, liveText, liveReasoning)
  const toolEvents = collectToolEvents(events, MAX_TOOL_EVENTS)

  let historyText = ''
  let openTurnText = ''
  let live = ''
  if (!opts.lite) {
    try { historyText = formatHistory(session.deriveMessages()) } catch { historyText = '' }
    // Open-turn already embeds streaming buffers — keep liveText empty in the
    // full snap so ask prompts do not send the same stream twice.
    openTurnText = formatOpenTurn(events, liveText, liveReasoning)
    live = ''
  } else {
    // Status strip: streaming tail, else a short "what just happened" preview.
    live = recentPreview(events, liveText, liveReasoning)
  }

  // Lite UI: only push active plan items. Completed plans stay in todosDone
  // so the client can hide them behind a collapsed disclosure.
  const todosForClient = opts.lite
    ? (planComplete ? [] : todosActive.slice(0, 8))
    : todosAll

  return {
    sessionId: String(session.id),
    title: safeTitle(session) ?? String(session.id).slice(0, 8),
    agentStatus,
    phase: phase.label,
    phaseDetail: phase.detail,
    turn: phase.turn,
    step: phase.step,
    todos: todosForClient,
    todosDone: opts.lite ? todosDone.slice(0, 12) : todosDone,
    planComplete,
    recentTools: phase.recentTools,
    toolEvents,
    historyText,
    openTurnText,
    liveText: live,
    eventCount: Number(session.seq) || 0,
    updatedAt: Date.now(),
  }
}

/**
 * @param {TaskSnapshot} snap
 * @param {string} question
 */
function buildAskPrompt(snap, question) {
  const system = [
    '你是 DeepSeek Harness 的「旁路任务助手」。',
    '用户正在主窗口跑任务；你旁听并回答，绝不 followup / steer / 改写主会话日志。',
    '最重要的依据是「进行中的回合对话」：本回合消息、工具调用/结果、未落盘流式回复。',
    '回答「现在在干什么 / 做到哪了」时，优先引用进行中回合与实时流。',
    '若进行中回合仍在生成或工具未返回，如实说明未完成，不要假装已结束。',
    '若可用工具已提供，你可以直接调用工具查证；工具结果只用于本次旁路回答，不会写入主会话。',
    '已完成的计划/待办不要反复强调，除非用户问到。',
    '若信息不足，明确说缺什么，不要编造。',
    '用用户提问的语言回答。',
  ].join('\n')

  // openTurnText already includes streaming-* blocks when present; only add a
  // separate live section if something slipped through without being embedded.
  const openHasStream = /\[streaming-(?:assistant|reasoning)/.test(snap.openTurnText || '')
  const liveExtra = (!openHasStream && snap.liveText)
    ? ['', '【实时流式输出 — 助手还在写、尚未落盘】', snap.liveText]
    : []

  const context = [
    `会话标题: ${snap.title}`,
    `Agent 状态: ${snap.agentStatus} · 阶段: ${snap.phase}`,
    `阶段细节: ${snap.phaseDetail}`,
    `轮次/步骤: turn=${snap.turn ?? '-'} step=${snap.step ?? '-'}`,
    '',
    '【进行中的回合对话 — 未完成工作，优先阅读】',
    snap.openTurnText || '(本回合暂无事件)',
    ...liveExtra,
    '',
    '【待办 / 计划】',
    snap.planComplete
      ? `(计划已全部完成，共 ${snap.todosDone?.length || snap.todos.length} 项；除非用户问起否则勿反复复述)`
      : formatTodos([
        ...(snap.todos || []),
        // full snap may already include done items inside todos
      ].filter((t, i, arr) => arr.findIndex((x) => x.content === t.content && x.status === t.status) === i)),
    '',
    '【最近工具】',
    (snap.toolEvents?.length
      ? snap.toolEvents.map((t) => `- [${t.kind}] ${t.name}${t.preview ? `: ${t.preview}` : ''}`).join('\n')
      : (snap.recentTools.length ? snap.recentTools.map((t) => `- ${t}`).join('\n') : '(无)')),
    '',
    '【更早历史摘要 — 仅作背景】',
    snap.historyText || '(暂无)',
  ].join('\n')

  const messages = [
    createUserMessage({
      content: [{ type: 'text', text: `【主会话只读旁听材料】\n${context}\n\n【用户旁路问题】\n${question}` }],
      source: { kind: 'plugin', plugin: 'dsh-plugin-task-ask' },
    }),
  ]
  return { system, messages }
}

/**
 * Cheap status-bar preview: prefer live stream, else last meaningful event.
 * @param {readonly any[]} events
 * @param {string} liveText
 * @param {string} liveReasoning
 */
function recentPreview(events, liveText, liveReasoning) {
  if (liveText) {
    return liveText.length > 240 ? liveText.slice(-240) : liveText
  }
  if (liveReasoning) {
    const tail = liveReasoning.slice(-200)
    return `[thinking] ${tail}`
  }
  const from = Math.max(0, events.length - 48)
  for (let i = events.length - 1; i >= from; i -= 1) {
    const ev = events[i]
    switch (ev.type) {
      case 'assistant/message':
      case 'assistant/attempt': {
        const text = eventText(ev).trim()
        if (text) return text.length > 240 ? text.slice(-240) : text
        break
      }
      case 'tool/result': {
        const body = contentToText(ev.data?.message?.content).trim()
        const callId = String(ev.data?.message?.toolCallId ?? '')
        const label = callId ? `工具结果 ${callId.slice(0, 12)}` : '工具结果'
        if (body) {
          const clip = body.length > 200 ? body.slice(-200) : body
          return `${label}: ${clip}`
        }
        break
      }
      case 'tool/call': {
        const name = String(ev.data?.name ?? 'tool')
        const args = typeof ev.data?.arguments === 'string'
          ? ev.data.arguments
          : ''
        const clip = args ? truncate(args, 120) : ''
        return clip ? `调用 ${name}: ${clip}` : `调用 ${name}`
      }
      case 'user/message': {
        const text = eventText(ev).trim()
        if (text && (ev.data?.source?.kind === 'user' || !ev.data?.source)) {
          return text.length > 200 ? text.slice(0, 200) : text
        }
        break
      }
      default:
        break
    }
  }
  return ''
}

/**
 * Transcript of the current unfinished turn: durable events since last
 * turn/start (or last user message), plus any still-streaming assistant text.
 * @param {readonly any[]} events
 * @param {string} liveText
 * @param {string} liveReasoning
 */
function formatOpenTurn(events, liveText, liveReasoning) {
  let start = 0
  let foundTurn = false
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === 'turn/start') {
      start = i
      foundTurn = true
      break
    }
  }
  if (!foundTurn) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i].type === 'user/message'
        && (events[i].data?.source?.kind === 'user' || !events[i].data?.source)) {
        start = i
        break
      }
    }
  }

  const lines = []
  let used = 0
  const push = (line) => {
    if (!line) return true
    if (used + line.length > MAX_OPEN_TURN_CHARS) {
      lines.push('…(本回合更早部分已截断)')
      return false
    }
    lines.push(line)
    used += line.length
    return true
  }

  /** @type {Map<string, string>} */
  const callNames = new Map()

  for (let i = start; i < events.length; i += 1) {
    const ev = events[i]
    let line = ''
    switch (ev.type) {
      case 'turn/start':
        line = `[turn ${ev.data?.turn ?? '?'} 开始]`
        break
      case 'step/start':
        line = `[step ${ev.data?.step ?? '?'} 开始]`
        break
      case 'user/message': {
        // user/message data IS the UserMessage
        const text = eventText(ev).trim()
        if (text) line = `[user] ${truncate(text, 4_000)}`
        break
      }
      case 'assistant/message':
      case 'assistant/attempt': {
        // assistant/* wraps { message } or { stream }
        const text = eventText(ev).trim()
        if (text) line = `[assistant] ${truncate(text, 8_000)}`
        break
      }
      case 'tool/call': {
        const callId = String(ev.data?.callId ?? '')
        const name = String(ev.data?.name ?? 'tool')
        if (callId) callNames.set(callId, name)
        const args = ev.data?.arguments
        const argText = typeof args === 'string'
          ? args
          : args != null ? JSON.stringify(args) : ''
        line = `[tool-call] ${name}${argText ? ` ${truncate(argText, 1_500)}` : ''}`
        break
      }
      case 'tool/result': {
        // Schema: { message: ToolResultMessage, error?, meta? }
        const msg = ev.data?.message
        const callId = String(msg?.toolCallId ?? '')
        const name = (callId && callNames.get(callId)) || callId || 'tool'
        let body = contentToText(msg?.content).trim()
        if (!body && ev.data?.error) {
          const err = ev.data.error
          body = `Error: ${err.reason || err.code || err.name || JSON.stringify(err)}`
        }
        if (msg?.isError && body && !body.startsWith('Error:')) {
          body = `Error: ${body}`
        }
        line = `[tool-result] ${name}${body ? `\n${truncate(body, 3_000)}` : ''}`
        break
      }
      case 'todo/write':
        line = `[todo] ${formatTodos((ev.data?.todos || []).map((t) => ({
          content: String(t.content ?? ''),
          status: String(t.status ?? 'pending'),
        })))}`
        break
      default:
        break
    }
    if (line && push(line) === false) break
  }

  if (liveReasoning) {
    push(`[streaming-reasoning — 未落盘]\n${truncate(liveReasoning, 4_000)}`)
  }
  if (liveText) {
    push(`[streaming-assistant — 正在生成、尚未落盘]\n${truncate(liveText, 12_000)}`)
  }

  return lines.join('\n\n')
}

/**
 * Pull readable text from a session event. Durable assistant/tool payloads
 * nest content under `data.message`; attempts may only have `data.stream`.
 * @param {any} ev
 */
function eventText(ev) {
  const d = ev?.data
  if (!d) return ''
  if (d.message?.content != null) return contentToText(d.message.content)
  if (d.content != null) return contentToText(d.content)
  if (Array.isArray(d.stream)) {
    let text = ''
    let reasoning = ''
    for (const rec of d.stream) {
      const chunk = rec?.chunk ?? rec
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text
    }
    if (text) return text
    if (reasoning) return `[thinking] ${reasoning}`
  }
  return ''
}

/**
 * @param {any} llm
 * @param {any} sessions
 * @param {() => any} getDefaultModel
 * @param {TaskSnapshot} snap
 * @param {string} question
 * @param {AbortSignal} [signal]
 * @param {{ tools?: any }} [opts]
 */
async function* streamAnswer(llm, sessions, getDefaultModel, snap, question, signal, opts = {}) {
  const route = resolveRoute(sessions, getDefaultModel, snap.sessionId)
  const { system, messages } = buildAskPrompt(snap, question)
  const toolSvc = opts.tools || null
  const toolDefs = listToolDefinitions(toolSvc)

  const ac = new AbortController()
  const onAbort = () => ac.abort()
  if (signal) {
    if (signal.aborted) ac.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => ac.abort(), ASK_TIMEOUT_MS)

  /** @type {any[]} */
  let chat = [...messages]

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      /** @type {{ id?: string, name: string, arguments: string }[]} */
      const pendingCalls = []
      let sawText = false
      const req = {
        provider: route.provider,
        model: route.model,
        messages: chat,
        system,
        maxTokens: MAX_ANSWER_TOKENS,
        signal: ac.signal,
        ...(toolDefs.length ? { tools: toolDefs } : {}),
      }

      for await (const chunk of llm.stream(req)) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
          sawText = true
          yield { kind: 'text', text: chunk.text }
          continue
        }
        // Tolerate several stream shapes for tool calls.
        const call = normalizeToolCallChunk(chunk)
        if (call) pendingCalls.push(call)
      }

      if (!pendingCalls.length || !toolSvc) {
        if (!sawText && round === 0 && !pendingCalls.length) {
          // nothing
        }
        break
      }

      for (const call of pendingCalls) {
        yield {
          kind: 'tool',
          name: call.name,
          status: 'running',
          arguments: call.arguments,
        }
        let resultText = ''
        let isError = false
        try {
          resultText = await executeToolCall(toolSvc, call.name, call.arguments, ac.signal)
        } catch (err) {
          isError = true
          resultText = err instanceof Error ? err.message : String(err)
        }
        yield {
          kind: 'tool',
          name: call.name,
          status: isError ? 'error' : 'done',
          preview: truncate(String(resultText), 1_200),
        }
        chat = appendToolTurn(chat, call, resultText, isError)
      }
    }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * @param {any} llm
 * @param {any} sessions
 * @param {() => any} getDefaultModel
 * @param {TaskSnapshot} snap
 * @param {string} question
 * @param {{ tools?: any }} [opts]
 */
async function answerQuestion(llm, sessions, getDefaultModel, snap, question, opts = {}) {
  let text = ''
  for await (const piece of streamAnswer(llm, sessions, getDefaultModel, snap, question, undefined, opts)) {
    if (typeof piece === 'string') text += piece
    else if (piece?.kind === 'text') text += piece.text
  }
  text = text.trim()
  if (!text) throw new Error('模型未返回文本')
  return text
}

/** @param {any} tools */
function listToolDefinitions(tools) {
  if (!tools) return []
  try {
    if (typeof tools.definitions === 'function') {
      const defs = tools.definitions()
      return Array.isArray(defs) ? defs : []
    }
    if (typeof tools.list === 'function') {
      const list = tools.list()
      return Array.isArray(list) ? list : []
    }
    if (Array.isArray(tools.catalog)) return tools.catalog
  } catch { /* ignore */ }
  return []
}

/**
 * @param {any} chunk
 * @returns {{ id?: string, name: string, arguments: string } | null}
 */
function normalizeToolCallChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return null
  if (chunk.type === 'tool-call' || chunk.type === 'tool_call') {
    const name = String(chunk.name || chunk.toolName || '')
    if (!name) return null
    const args = typeof chunk.arguments === 'string'
      ? chunk.arguments
      : chunk.arguments != null ? JSON.stringify(chunk.arguments) : '{}'
    return { id: chunk.id || chunk.toolCallId, name, arguments: args }
  }
  if (chunk.type === 'tool-call-delta' && chunk.toolCall) {
    return normalizeToolCallChunk({ type: 'tool-call', ...chunk.toolCall })
  }
  return null
}

/**
 * @param {any} tools
 * @param {string} name
 * @param {string} argsJson
 * @param {AbortSignal} [signal]
 */
async function executeToolCall(tools, name, argsJson, signal) {
  let args = {}
  try { args = argsJson ? JSON.parse(argsJson) : {} } catch { args = { raw: argsJson } }
  const runners = ['execute', 'invoke', 'call', 'run']
  for (const key of runners) {
    if (typeof tools?.[key] === 'function') {
      const out = await tools[key](name, args, { signal })
      return stringifyToolResult(out)
    }
  }
  if (typeof tools?.get === 'function') {
    const tool = tools.get(name)
    if (tool && typeof tool.execute === 'function') {
      return stringifyToolResult(await tool.execute(args, { signal }))
    }
  }
  throw new Error(`无法执行工具 ${name}：未找到 tools.execute / invoke`)
}

/** @param {unknown} out */
function stringifyToolResult(out) {
  if (out == null) return ''
  if (typeof out === 'string') return out
  if (typeof out === 'object' && out && 'content' in /** @type {any} */ (out)) {
    return contentToText(/** @type {any} */ (out).content) || JSON.stringify(out)
  }
  try { return JSON.stringify(out, null, 2) } catch { return String(out) }
}

/**
 * Append assistant tool-call + tool result into a local message list (never session).
 * @param {any[]} messages
 * @param {{ id?: string, name: string, arguments: string }} call
 * @param {string} resultText
 * @param {boolean} isError
 */
function appendToolTurn(messages, call, resultText, isError) {
  const next = messages.slice()
  const callId = call.id || `call_${Date.now()}`
  next.push({
    role: 'assistant',
    content: [{
      type: 'tool-call',
      id: callId,
      name: call.name,
      arguments: call.arguments,
    }],
  })
  next.push({
    role: 'tool',
    toolCallId: callId,
    isError: isError || undefined,
    content: [{ type: 'text', text: truncate(resultText, 8_000) }],
  })
  return next
}

/**
 * Recent tool call/result pairs for the collapsible tools panel.
 * @param {readonly any[]} events
 * @param {number} limit
 * @returns {ToolEventItem[]}
 */
function collectToolEvents(events, limit) {
  /** @type {ToolEventItem[]} */
  const items = []
  /** @type {Map<string, string>} */
  const names = new Map()
  for (const ev of events) {
    if (ev.type === 'tool/call') {
      const callId = String(ev.data?.callId ?? '')
      const name = String(ev.data?.name ?? 'tool')
      if (callId) names.set(callId, name)
      const args = typeof ev.data?.arguments === 'string' ? ev.data.arguments : ''
      items.push({
        name,
        kind: 'call',
        preview: args ? truncate(args, 160) : '',
      })
    } else if (ev.type === 'tool/result') {
      const msg = ev.data?.message
      const callId = String(msg?.toolCallId ?? '')
      const name = (callId && names.get(callId)) || callId || 'tool'
      const body = contentToText(msg?.content).trim()
      const err = ev.data?.error
      items.push({
        name,
        kind: 'result',
        preview: truncate(body || (err ? `Error: ${err.reason || err.code || err.name}` : ''), 240),
        isError: Boolean(msg?.isError || err),
      })
    }
  }
  return items.slice(-limit)
}

/**
 * @param {any} sessions
 * @param {() => any} getDefaultModel
 * @param {string} sessionId
 */
function resolveRoute(sessions, getDefaultModel, sessionId) {
  const session = sessions.get(/** @type {any} */ (sessionId))
  const header = session?.requestHeader?.()
  if (header?.config?.provider && header?.config?.model) {
    return { provider: header.config.provider, model: header.config.model }
  }
  const defaults = getDefaultModel()
  if (defaults?.provider && defaults?.model) {
    return { provider: defaults.provider, model: defaults.model }
  }
  throw new Error('无法解析模型路由：会话尚无 request/header，且未配置默认模型')
}

/** @param {any} session */
function safeTitle(session) {
  try {
    const events = session.snapshotEvents()
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i]
      if (ev.type === 'session/title' && typeof ev.data?.title === 'string' && ev.data.title) {
        return ev.data.title
      }
    }
  } catch { /* ignore */ }
  return undefined
}

/** @param {readonly any[]} events */
function latestTodos(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]
    if (ev.type === 'todo/write' && Array.isArray(ev.data?.todos)) {
      return ev.data.todos.map((t) => ({
        content: String(t.content ?? ''),
        status: String(t.status ?? 'pending'),
      }))
    }
  }
  return []
}

/**
 * @param {readonly any[]} events
 * @param {string} agentStatus
 * @param {string} liveText
 * @param {string} [liveReasoning]
 */
function inferPhase(events, agentStatus, liveText, liveReasoning = '') {
  let turn = null
  let step = null
  /** @type {string[]} */
  const recentTools = []
  let lastTool = ''
  let lastUser = ''
  let waiting = false

  for (const ev of events) {
    switch (ev.type) {
      case 'turn/start':
        turn = ev.data?.turn ?? turn
        waiting = false
        break
      case 'turn/end':
        turn = ev.data?.turn ?? turn
        waiting = true
        break
      case 'step/start':
        step = ev.data?.step ?? step
        turn = ev.data?.turn ?? turn
        waiting = false
        break
      case 'step/end':
        step = ev.data?.step ?? step
        break
      case 'tool/call': {
        const name = String(ev.data?.name ?? 'tool')
        lastTool = name
        recentTools.push(name)
        if (recentTools.length > 8) recentTools.shift()
        waiting = false
        break
      }
      case 'user/message': {
        const text = eventText(ev)
        if (text && (ev.data?.source?.kind === 'user' || !ev.data?.source)) {
          lastUser = text.slice(0, 200)
        }
        break
      }
      default:
        break
    }
  }

  let label = '空闲'
  let detail = lastUser ? `最近用户目标：${lastUser}` : '暂无进行中的步骤'

  if (agentStatus === 'running') {
    if (liveReasoning && !liveText) {
      label = '思考中'
      detail = '模型正在推理下一步'
    } else if (lastTool && !liveText) {
      label = '执行工具'
      detail = `最近调用：${lastTool}`
    } else if (liveText) {
      label = '生成回复'
      detail = '正在流式输出助手内容'
    } else {
      label = '工作中'
      detail = `turn=${turn ?? '-'} step=${step ?? '-'}`
    }
  } else if (waiting || agentStatus === 'idle') {
    label = events.length ? '等待中' : '空闲'
    detail = lastTool
      ? `上一工具：${lastTool}；可继续提问主窗口任务`
      : detail
  }

  return { label, detail, turn, step, recentTools }
}

/** @param {readonly any[]} messages */
function formatHistory(messages) {
  // Keep the *tail* (recent context). A forward pass previously kept the
  // oldest messages and dropped the newest — useless for "现在在干什么".
  const lines = []
  for (const msg of messages) {
    const role = msg.role ?? 'unknown'
    if (role === 'system') continue
    const text = contentToText(msg.content).trim()
    if (!text) continue
    lines.push(`[${role}] ${text}`)
  }
  const kept = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (used + line.length > MAX_HISTORY_CHARS) {
      kept.push('…(更早历史已截断)')
      break
    }
    kept.push(line)
    used += line.length
  }
  return kept.reverse().join('\n\n')
}

/** @param {TodoItem[]} todos */
function formatTodos(todos) {
  if (!todos.length) return '(无待办快照)'
  const done = todos.filter((t) => t.status === 'completed').length
  const head = `进度 ${done}/${todos.length}`
  const body = todos.map((t) => {
    const mark = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'
    return `${mark} ${t.content}`
  }).join('\n')
  return `${head}\n${body}`
}

/** @param {unknown} content */
function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      if (block.type === 'text' || block.type === 'reasoning') return String(block.text ?? '')
      if (block.type === 'tool-call') return `调用 ${block.name}`
      if (block.type === 'tool-result') return contentToText(block.content)
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function truncate(text, max) {
  if (text.length <= max) return text
  return text.slice(text.length - max)
}

function json(res, data, status = 200) {
  const body = Buffer.from(JSON.stringify(data), 'utf8')
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

function sendFile(res, filePath, contentType) {
  const stream = createReadStream(filePath)
  stream.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 404
      res.end('not found')
    }
  })
  res.statusCode = 200
  res.setHeader('Content-Type', contentType)
  res.setHeader('Cache-Control', 'no-cache')
  stream.pipe(res)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
