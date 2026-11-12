/**
 * Client half: right-Sidebar page tab (same path as Files) + header opener.
 * Visual language mirrors the main conversation: InputBar composer card,
 * user bubble, and official MarkdownText for assistant replies.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-task-ask',
  factory: (require) => {
    const React = require('react')
    const { useEffect, useMemo, useRef, useState } = React
    const { jsx, jsxs } = require('react/jsx-runtime')
    // Same Markdown renderer the main chat AssistantMarkdown uses.
    const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives')

    const TAB_ID = 'dsh-plugin-task-ask'
    const TAB_KIND = 'task-ask'
    const STYLE_ID = 'dsh-task-ask-sidebar-style'

    /** Chrome labels for MarkdownText (mirrors chat markdownLabels). */
    const MD_LABELS = {
      code: {
        copyLabel: '复制',
        copiedLabel: '已复制',
        toolbarLabels: {
          codeLabel: '代码',
          wrapLabel: '自动换行',
          unwrapLabel: '取消换行',
        },
      },
      footnotes: '脚注',
    }

    const HINTS = [
      { label: '现在在干什么', q: '现在在干什么？' },
      { label: '做到哪一步了', q: '任务做到哪一步了？' },
      { label: '待办进度', q: '还有哪些待办没完成？' },
      { label: '最近工具', q: '最近调用了哪些工具？' },
    ]

    const SEND_PATH = 'M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z'

    function ensureStyles() {
      if (typeof document === 'undefined') return
      const existing = document.getElementById(STYLE_ID)
      if (existing) existing.remove()
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
        .taskAsk.root {
          display: flex;
          flex: 1 1 auto;
          flex-direction: column;
          height: 100%;
          min-height: 0;
          color: var(--dsw-alias-label-primary);
          font-family: var(--dsw-font-family, inherit);
          font-size: var(--dsh-content-font-size, 14px);
          line-height: calc(24px + var(--dsh-content-font-delta, 0px));
        }
        .taskAsk.header {
          display: flex;
          flex: 0 0 auto;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          box-sizing: border-box;
          height: 38px;
          padding: 0 12px 0 16px;
          border-bottom: 0.5px solid var(--dsw-alias-border-l3);
        }
        .taskAsk.headerTitle {
          margin: 0;
          font-size: 12px;
          font-weight: 600;
          color: var(--dsw-alias-label-primary);
        }
        .taskAsk.headerHint {
          margin: 0;
          font-size: 11px;
          color: var(--dsw-alias-label-tertiary);
          white-space: nowrap;
        }
        .taskAsk.status {
          flex: 0 0 auto;
          padding: 10px 16px;
          border-bottom: 0.5px solid var(--dsw-alias-border-l3);
        }
        .taskAsk.phaseRow {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }
        .taskAsk.dot {
          flex: 0 0 auto;
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: var(--dsw-alias-label-tertiary);
        }
        .taskAsk.dotRunning {
          background: var(--dsw-alias-state-business-primary, #3964fe);
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary, #3964fe) 22%, transparent);
        }
        .taskAsk.phase {
          margin: 0;
          min-width: 0;
          font-size: var(--dsh-content-font-size-secondary, 13px);
          font-weight: 600;
          line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
          color: var(--dsw-alias-label-primary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .taskAsk.detail {
          margin: 6px 0 0;
          font-size: var(--dsh-content-font-size-secondary, 13px);
          line-height: calc(18px + var(--dsh-content-font-delta-secondary, 0px));
          color: var(--dsw-alias-label-secondary);
        }
        .taskAsk.meta {
          margin: 4px 0 0;
          font-size: 11px;
          color: var(--dsw-alias-label-tertiary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .taskAsk.live {
          margin: 8px 0 0;
          padding: 8px 10px;
          border-radius: 10px;
          background: var(--dsw-alias-interactive-bg-hover);
          font-size: var(--dsh-content-font-size-secondary, 13px);
          line-height: calc(18px + var(--dsh-content-font-delta-secondary, 0px));
          color: var(--dsw-alias-label-secondary);
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 4.8em;
          overflow: hidden;
        }
        .taskAsk.liveLabel {
          display: block;
          margin-bottom: 4px;
          font-size: 11px;
          font-weight: 600;
          color: var(--dsw-alias-label-tertiary);
          letter-spacing: 0.02em;
        }
        .taskAsk.fold {
          margin: 8px 0 0;
          border-radius: 10px;
          background: var(--dsw-alias-interactive-bg-hover);
          overflow: hidden;
        }
        .taskAsk.fold > summary {
          list-style: none;
          cursor: pointer;
          user-select: none;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 8px 10px;
          font-size: 11px;
          font-weight: 600;
          color: var(--dsw-alias-label-tertiary);
          letter-spacing: 0.02em;
        }
        .taskAsk.fold > summary::-webkit-details-marker { display: none; }
        .taskAsk.fold > summary::after {
          content: "";
          width: 6px;
          height: 6px;
          border-right: 1.5px solid currentColor;
          border-bottom: 1.5px solid currentColor;
          transform: rotate(-45deg);
          transition: transform 0.12s ease;
          flex: none;
        }
        .taskAsk.fold[open] > summary::after {
          transform: rotate(45deg);
        }
        .taskAsk.foldBody {
          padding: 0 10px 8px;
        }
        .taskAsk.toolRow {
          display: grid;
          gap: 2px;
          margin: 0 0 6px;
          font-size: var(--dsh-content-font-size-secondary, 13px);
          line-height: calc(18px + var(--dsh-content-font-delta-secondary, 0px));
          color: var(--dsw-alias-label-secondary);
        }
        .taskAsk.toolName {
          font-weight: 600;
          color: var(--dsw-alias-label-primary);
        }
        .taskAsk.toolPreview {
          white-space: pre-wrap;
          word-break: break-word;
          color: var(--dsw-alias-label-tertiary);
          max-height: 4.5em;
          overflow: hidden;
        }
        .taskAsk.toolError { color: var(--dsw-alias-state-error-primary, #c44); }
        .taskAsk.inlineTools {
          margin: 0 0 8px;
          padding: 8px 10px;
          border-radius: 10px;
          background: var(--dsw-alias-interactive-bg-hover);
          font-size: var(--dsh-content-font-size-secondary, 13px);
          color: var(--dsw-alias-label-secondary);
        }
        .taskAsk.todos {
          list-style: none;
          margin: 8px 0 0;
          padding: 0;
          display: grid;
          gap: 2px;
        }
        .taskAsk.todos li {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          margin: 0;
          padding: 4px 6px;
          border-radius: 8px;
          font-size: var(--dsh-content-font-size-secondary, 13px);
          line-height: calc(18px + var(--dsh-content-font-delta-secondary, 0px));
          color: var(--dsw-alias-label-secondary);
        }
        .taskAsk.todos li:hover {
          background: var(--dsw-alias-interactive-bg-hover);
        }
        .taskAsk.check {
          flex: 0 0 auto;
          width: 12px;
          height: 12px;
          margin-top: 3px;
          border: 1.5px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l3));
          border-radius: 3px;
          box-sizing: border-box;
        }
        .taskAsk.todoDone {
          color: var(--dsw-alias-label-tertiary);
          text-decoration: line-through;
        }
        .taskAsk.todoDone .taskAsk.check {
          background: var(--dsw-alias-label-tertiary);
          border-color: var(--dsw-alias-label-tertiary);
        }
        .taskAsk.todoActive {
          color: var(--dsw-alias-label-primary);
          font-weight: 600;
        }
        .taskAsk.chat {
          flex: 1 1 auto;
          min-height: 0;
          overflow: auto;
          margin-right: 2px;
          padding: 16px 16px 12px;
          display: flex;
          flex-direction: column;
          gap: 16px;
          scrollbar-gutter: stable;
          --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
          --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
        }
        .taskAsk.chat::-webkit-scrollbar-track { margin: 2px; }
        .taskAsk.empty {
          margin: auto;
          padding: 24px 16px;
          text-align: center;
          color: var(--dsw-alias-label-tertiary);
          font-size: var(--dsh-content-font-size-secondary, 13px);
          line-height: calc(18px + var(--dsh-content-font-delta-secondary, 0px));
        }
        .taskAsk.userRow {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 6px;
          align-self: flex-end;
          max-width: 92%;
          min-width: 0;
        }
        .taskAsk.bubble {
          max-width: 100%;
          background: var(--dsw-specific-bubble);
          border-radius: 22px;
          padding: 10px 16px;
          font-size: var(--dsh-content-font-size, 14px);
          line-height: calc(22px + var(--dsh-content-font-delta, 0px));
          color: var(--dsw-alias-label-primary);
          white-space: pre-wrap;
          word-break: break-word;
        }
        .taskAsk.botRow {
          align-self: stretch;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 0;
        }
        .taskAsk.assistant {
          min-width: 0;
          font-size: var(--dsh-content-font-size, 14px);
          line-height: calc(24px + var(--dsh-content-font-delta, 0px));
          color: var(--dsw-alias-label-primary);
        }
        .taskAsk.turnStatus {
          align-self: flex-start;
          font: var(--dsw-font-s-strong-14, 600 14px/22px inherit);
          font-size: var(--dsh-content-font-size, 14px);
          line-height: calc(22px + var(--dsh-content-font-delta, 0px));
          white-space: nowrap;
          background: linear-gradient(
            90deg,
            var(--dsw-static-deepseek-500, #4d6bfe) 0%,
            var(--dsw-static-deepseek-500, #4d6bfe) 40%,
            var(--dsw-static-deepseek-200, #b8c7ff) 50%,
            var(--dsw-static-deepseek-500, #4d6bfe) 60%,
            var(--dsw-static-deepseek-500, #4d6bfe) 100%
          );
          background-position: 100% 0;
          background-size: 250% 100%;
          background-clip: text;
          color: transparent;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          animation: taskAskShimmer 1.8s linear infinite;
        }
        @keyframes taskAskShimmer {
          to { background-position: 0 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .taskAsk.turnStatus {
            background-position: 0 0;
            background-size: 100% 100%;
            animation: none;
          }
        }
        .taskAsk.msgError {
          color: var(--dsw-alias-state-error-primary, #c44);
          font-size: var(--dsh-content-font-size-secondary, 13px);
          line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
        }
        .taskAsk.composer {
          flex: 0 0 auto;
          padding: 0 12px 10px;
        }
        .taskAsk.hints {
          display: flex;
          flex-wrap: wrap;
          gap: 6px 12px;
          margin: 0 4px 8px;
        }
        .taskAsk.hints button {
          border: 0;
          padding: 0;
          background: transparent;
          color: var(--dsw-alias-label-secondary);
          font: 500 12px/1.3 inherit;
          cursor: pointer;
          text-decoration: underline;
          text-underline-offset: 2px;
          text-decoration-color: var(--dsw-alias-border-l2, var(--dsw-alias-border-l3));
        }
        .taskAsk.hints button:hover { color: var(--dsw-alias-label-primary); }
        .taskAsk.hints button:disabled { opacity: 0.45; cursor: default; }
        .taskAsk.card {
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          gap: 12px;
          width: 100%;
          padding-top: 8px;
          border: 0;
          --dsw-elevation-stroke-color: var(--dsw-alias-border-l2);
          border-radius: 22px;
          background: var(--dsw-specific-input-major);
          box-shadow: var(--dsw-elevation-soft);
          font-size: var(--dsh-content-font-size, 14px);
          line-height: calc(24px + var(--dsh-content-font-delta, 0px));
          --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
          --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
        }
        .taskAsk.scroll {
          max-height: 120px;
          overflow-y: auto;
          margin-right: 4px;
        }
        .taskAsk.scroll::-webkit-scrollbar-track { margin-top: 8px; }
        .taskAsk.grow { position: relative; }
        .taskAsk.input {
          box-sizing: border-box;
          display: block;
          width: 100%;
          min-height: 36px;
          max-height: 120px;
          margin: 0;
          padding: 4px 8px 0 14px;
          border: 0;
          resize: none;
          background: transparent;
          font-family: var(--dsw-font-family, inherit);
          font-size: inherit;
          line-height: inherit;
          white-space: pre-wrap;
          word-break: break-word;
          overflow-wrap: anywhere;
          outline: none;
          color: var(--dsw-alias-label-primary);
          caret-color: var(--dsw-alias-state-business-primary);
        }
        .taskAsk.input:disabled {
          color: var(--dsw-alias-label-tertiary);
          cursor: not-allowed;
        }
        .taskAsk.placeholder {
          position: absolute;
          inset: 4px 8px auto 14px;
          color: var(--dsw-alias-label-caption);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          pointer-events: none;
          user-select: none;
        }
        .taskAsk.row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: flex-end;
          gap: 12px;
          padding: 2px 8px 6px;
          min-width: 0;
        }
        .taskAsk.primary {
          display: grid;
          place-items: center;
          flex: none;
          width: 34px;
          height: 34px;
          border: none;
          border-radius: 999px;
          background: var(--dsw-alias-button-info-fill);
          color: #fff;
          cursor: pointer;
          transition: background-color 100ms ease;
          transform: translateY(-2px);
        }
        .taskAsk.primary:hover:not(:disabled) {
          background: var(--dsw-alias-button-info-hover);
        }
        .taskAsk.primary:disabled {
          opacity: 0.4;
          cursor: default;
        }
        .taskAsk.note {
          margin: 6px 4px 0;
          font-size: 11px;
          color: var(--dsw-alias-label-tertiary);
        }
        .taskAsk.headerBtn {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          min-height: 28px;
          padding: 3px 6px;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--dsw-alias-label-tertiary);
          font-size: 12px;
          line-height: 18px;
          cursor: pointer;
        }
        .taskAsk.headerBtn:hover,
        .taskAsk.headerBtn:focus-visible {
          color: var(--dsw-alias-label-secondary);
        }
      `
      document.head.appendChild(style)
    }

    async function consumeAskStream(res, { onDelta, onTool }) {
      if (!res.body || !res.body.getReader) {
        const text = await res.text()
        if (!text) throw new Error(res.ok ? '空响应' : `请求失败（HTTP ${res.status}）`)
        let data
        try { data = JSON.parse(text) } catch {
          throw new Error(res.ok ? '响应不是 JSON' : `请求失败（HTTP ${res.status}）`)
        }
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
        if (data.answer) onDelta(data.answer)
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let full = ''
      let sawEvent = false
      let streamError = null

      const handleBlock = (block) => {
        const lines = block.split('\n')
        let event = 'message'
        const dataLines = []
        for (const line of lines) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
        }
        if (!dataLines.length) return
        let data
        try { data = JSON.parse(dataLines.join('\n')) } catch { return }
        sawEvent = true
        if (event === 'delta' && typeof data.text === 'string') {
          full += data.text
          onDelta(full)
        } else if (event === 'tool' && typeof onTool === 'function') {
          onTool(data)
        } else if (event === 'error') {
          streamError = new Error(data.error || '流式失败')
        }
      }

      while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
        let sep
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          if (block.trim()) handleBlock(block)
        }
        if (done) break
      }
      if (buffer.trim()) handleBlock(buffer)

      if (streamError) throw streamError
      if (!res.ok && !sawEvent) throw new Error(`请求失败（HTTP ${res.status}）`)
      if (!full.trim() && !sawEvent) {
        throw new Error('模型未返回文本')
      }
      return full
    }

    function AssistantBody({ text, streaming, error, tools }) {
      const labels = useMemo(() => MD_LABELS, [])
      if (error) {
        return jsx('div', { className: 'taskAsk msgError', children: text })
      }
      const toolList = Array.isArray(tools) ? tools : []
      const body = (!text && streaming)
        ? jsx('div', { className: 'taskAsk turnStatus', children: '思考中' })
        : jsx('div', {
          className: 'taskAsk assistant',
          'data-streaming': streaming || undefined,
          children: jsx(MarkdownText, {
            text: String(text || ''),
            streaming: Boolean(streaming),
            labels,
          }),
        })
      if (!toolList.length) return body
      return jsxs('div', {
        children: [
          jsxs('details', {
            className: 'taskAsk fold',
            open: toolList.some((t) => t.status === 'running'),
            children: [
              jsx('summary', {
                children: `旁路工具 · ${toolList.length}`,
              }),
              jsx('div', {
                className: 'taskAsk foldBody',
                children: toolList.map((t, i) => jsxs('div', {
                  className: `taskAsk toolRow${t.status === 'error' ? ' toolError' : ''}`,
                  children: [
                    jsx('span', {
                      className: 'taskAsk toolName',
                      children: `${t.name} · ${t.status === 'running' ? '执行中' : t.status === 'error' ? '失败' : '完成'}`,
                    }),
                    t.preview
                      ? jsx('div', { className: 'taskAsk toolPreview', children: t.preview })
                      : null,
                  ],
                }, `${t.name}-${i}`)),
              }),
            ],
          }),
          body,
        ],
      })
    }

    function TodoList({ items }) {
      if (!items?.length) return null
      return jsx('ul', {
        className: 'taskAsk todos',
        children: items.map((todo, i) => jsxs('li', {
          className: todo.status === 'completed'
            ? 'taskAsk todoDone'
            : todo.status === 'in_progress' ? 'taskAsk todoActive' : undefined,
          children: [
            jsx('span', { className: 'taskAsk check', 'aria-hidden': true }),
            jsx('span', { children: todo.content }),
          ],
        }, `${todo.content}-${i}`)),
      })
    }

    function TaskAskBody({ sessionId }) {
      ensureStyles()
      const [snap, setSnap] = useState(null)
      const [messages, setMessages] = useState([
        { role: 'bot', text: '主任务继续跑。在这里询问进度即可，不会写入主会话。' },
      ])
      const [draft, setDraft] = useState('')
      const [asking, setAsking] = useState(false)
      const chatRef = useRef(null)
      const inputRef = useRef(null)
      const abortRef = useRef(null)

      useEffect(() => {
        if (!sessionId) {
          setSnap(null)
          return undefined
        }
        let cancelled = false
        const applySnap = (data) => {
          if (!cancelled && data && typeof data === 'object' && data.phase) setSnap(data)
        }
        void fetch(`/api/task-ask/snapshot?sessionId=${encodeURIComponent(String(sessionId))}&lite=1`)
          .then((r) => r.ok ? r.json() : null)
          .then(applySnap)
          .catch(() => { /* ignore */ })

        const url = new URL('/api/task-ask/events', location.origin)
        url.searchParams.set('sessionId', String(sessionId))
        const source = new EventSource(url.toString())
        source.addEventListener('snapshot', (ev) => {
          try { applySnap(JSON.parse(ev.data)) } catch { /* ignore oversized/bad frames */ }
        })
        return () => {
          cancelled = true
          source.close()
        }
      }, [sessionId])

      useEffect(() => {
        const node = chatRef.current
        if (node) node.scrollTop = node.scrollHeight
      }, [messages, asking])

      async function ask(question) {
        const q = String(question || '').trim()
        if (!q || !sessionId || asking) return
        abortRef.current?.abort()
        const ac = new AbortController()
        abortRef.current = ac
        setAsking(true)
        setMessages((prev) => [
          ...prev,
          { role: 'user', text: q },
          { role: 'bot', text: '', streaming: true },
        ])
        setDraft('')
        try {
          const res = await fetch('/api/task-ask/ask', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
            },
            body: JSON.stringify({ sessionId: String(sessionId), question: q, stream: true }),
            signal: ac.signal,
          })
          await consumeAskStream(res, {
            onDelta: (full) => {
              setMessages((prev) => {
                const next = prev.slice()
                const last = next[next.length - 1]
                if (!last || last.role !== 'bot') return prev
                next[next.length - 1] = { ...last, text: full, streaming: true, error: false }
                return next
              })
            },
            onTool: (ev) => {
              setMessages((prev) => {
                const next = prev.slice()
                const last = next[next.length - 1]
                if (!last || last.role !== 'bot') return prev
                const tools = Array.isArray(last.tools) ? last.tools.slice() : []
                const name = String(ev?.name || 'tool')
                const status = String(ev?.status || 'done')
                const preview = typeof ev?.preview === 'string'
                  ? ev.preview
                  : (typeof ev?.arguments === 'string' ? ev.arguments.slice(0, 240) : '')
                if (status === 'running') {
                  tools.push({ name, status, preview })
                } else {
                  let idx = -1
                  for (let i = tools.length - 1; i >= 0; i -= 1) {
                    if (tools[i].name === name && tools[i].status === 'running') {
                      idx = i
                      break
                    }
                  }
                  if (idx >= 0) tools[idx] = { ...tools[idx], status, preview: preview || tools[idx].preview }
                  else tools.push({ name, status, preview })
                }
                next[next.length - 1] = { ...last, tools, streaming: true, error: false }
                return next
              })
            },
          })
          setMessages((prev) => {
            const next = prev.slice()
            const last = next[next.length - 1]
            if (!last || last.role !== 'bot') return prev
            next[next.length - 1] = {
              ...last,
              text: last.text || (last.tools?.length ? '(工具已执行)' : '(无内容)'),
              streaming: false,
            }
            return next
          })
        } catch (err) {
          if (err?.name === 'AbortError') {
            setMessages((prev) => {
              const next = prev.slice()
              const last = next[next.length - 1]
              if (last && last.role === 'bot' && last.streaming) {
                if (!last.text) next.pop()
                else next[next.length - 1] = { ...last, streaming: false }
              }
              return next
            })
            return
          }
          setMessages((prev) => {
            const next = prev.slice()
            const last = next[next.length - 1]
            const message = err instanceof Error ? err.message : String(err)
            if (last && last.role === 'bot' && (last.streaming || !last.text)) {
              next[next.length - 1] = { role: 'bot', text: message, error: true, streaming: false }
              return next
            }
            next.push({ role: 'bot', text: message, error: true })
            return next
          })
        } finally {
          setAsking(false)
          inputRef.current?.focus()
        }
      }

      const todosActive = Array.isArray(snap?.todos) ? snap.todos.slice(0, 8) : []
      const todosDone = Array.isArray(snap?.todosDone) ? snap.todosDone.slice(0, 12) : []
      const toolEvents = Array.isArray(snap?.toolEvents) ? snap.toolEvents.slice(0, 10) : []
      const planComplete = Boolean(snap?.planComplete)
      const meta = snap
        ? [
          snap.title,
          snap.agentStatus,
          snap.turn != null ? `turn ${snap.turn}` : null,
          snap.step != null ? `step ${snap.step}` : null,
        ].filter(Boolean).join(' · ')
        : ''
      const running = snap?.agentStatus === 'running'
      const canSend = Boolean(sessionId) && !asking && Boolean(draft.trim())

      return jsxs('div', {
        className: 'taskAsk root',
        children: [
          jsxs('div', {
            className: 'taskAsk header',
            children: [
              jsx('p', { className: 'taskAsk headerTitle', children: '旁路询问' }),
              jsx('p', { className: 'taskAsk headerHint', children: '只读 · 可调工具 · 不打断' }),
            ],
          }),
          snap
            ? jsxs('div', {
              className: 'taskAsk status',
              children: [
                jsxs('div', {
                  className: 'taskAsk phaseRow',
                  children: [
                    jsx('span', {
                      className: `taskAsk dot${running ? ' dotRunning' : ''}`,
                      'aria-hidden': true,
                    }),
                    jsx('p', {
                      className: 'taskAsk phase',
                      children: snap.phase,
                    }),
                  ],
                }),
                snap.phaseDetail
                  ? jsx('p', { className: 'taskAsk detail', children: snap.phaseDetail })
                  : null,
                meta ? jsx('p', { className: 'taskAsk meta', children: meta }) : null,
                snap.liveText
                  ? jsxs('div', {
                    className: 'taskAsk live',
                    children: [
                      jsx('span', {
                        className: 'taskAsk liveLabel',
                        children: running ? '实时预览' : '最近动态',
                      }),
                      snap.liveText,
                    ],
                  })
                  : null,
                todosActive.length
                  ? jsxs('div', {
                    children: [
                      jsx('span', {
                        className: 'taskAsk liveLabel',
                        style: { marginTop: 8 },
                        children: '进行中计划',
                      }),
                      jsx(TodoList, { items: todosActive }),
                    ],
                  })
                  : null,
                planComplete && todosDone.length
                  ? jsxs('details', {
                    className: 'taskAsk fold',
                    children: [
                      jsx('summary', {
                        children: `已完成计划 · ${todosDone.length}`,
                      }),
                      jsx('div', {
                        className: 'taskAsk foldBody',
                        children: jsx(TodoList, { items: todosDone }),
                      }),
                    ],
                  })
                  : (!planComplete && todosDone.length
                    ? jsxs('details', {
                      className: 'taskAsk fold',
                      children: [
                        jsx('summary', {
                          children: `已完成 · ${todosDone.length}`,
                        }),
                        jsx('div', {
                          className: 'taskAsk foldBody',
                          children: jsx(TodoList, { items: todosDone }),
                        }),
                      ],
                    })
                    : null),
                toolEvents.length
                  ? jsxs('details', {
                    className: 'taskAsk fold',
                    children: [
                      jsx('summary', {
                        children: `工具动态 · ${toolEvents.length}`,
                      }),
                      jsx('div', {
                        className: 'taskAsk foldBody',
                        children: toolEvents.map((t, i) => jsxs('div', {
                          className: 'taskAsk toolRow',
                          children: [
                            jsx('span', {
                              className: 'taskAsk toolName',
                              children: `${t.name}${t.kind === 'result' ? ' · 结果' : ' · 调用'}`,
                            }),
                            t.preview
                              ? jsx('div', { className: 'taskAsk toolPreview', children: t.preview })
                              : null,
                          ],
                        }, `${t.name}-${t.kind}-${i}`)),
                      }),
                    ],
                  })
                  : null,
              ],
            })
            : null,
          jsx('div', {
            className: 'taskAsk chat',
            ref: chatRef,
            children: sessionId
              ? messages.map((msg, i) => (
                msg.role === 'user'
                  ? jsx('div', {
                    className: 'taskAsk userRow',
                    children: jsx('div', { className: 'taskAsk bubble', children: msg.text }),
                  }, i)
                  : jsx('div', {
                    className: 'taskAsk botRow',
                    children: jsx(AssistantBody, {
                      text: msg.text,
                      streaming: Boolean(msg.streaming),
                      error: Boolean(msg.error),
                      tools: msg.tools,
                    }),
                  }, i)
              ))
              : jsx('p', {
                className: 'taskAsk empty',
                children: '打开一个会话后，即可在此旁路询问当前任务。',
              }),
          }),
          jsxs('div', {
            className: 'taskAsk composer',
            children: [
              jsx('div', {
                className: 'taskAsk hints',
                children: HINTS.map((item) => jsx('button', {
                  type: 'button',
                  disabled: asking || !sessionId,
                  onClick: () => { void ask(item.q) },
                  children: item.label,
                }, item.label)),
              }),
              jsxs('div', {
                className: 'taskAsk card',
                children: [
                  jsx('div', {
                    className: 'taskAsk scroll',
                    children: jsxs('div', {
                      className: 'taskAsk grow',
                      children: [
                        jsx('textarea', {
                          ref: inputRef,
                          className: 'taskAsk input',
                          value: draft,
                          rows: 1,
                          disabled: asking || !sessionId,
                          'aria-label': '旁路询问输入',
                          onChange: (ev) => {
                            setDraft(ev.target.value)
                            const el = ev.target
                            el.style.height = 'auto'
                            el.style.height = `${Math.min(el.scrollHeight, 120)}px`
                          },
                          onKeyDown: (ev) => {
                            if (ev.key === 'Enter' && !ev.shiftKey) {
                              ev.preventDefault()
                              void ask(draft)
                            }
                          },
                        }),
                        !draft && sessionId
                          ? jsx('div', {
                            className: 'taskAsk placeholder',
                            children: '询问当前任务或历史…',
                          })
                          : !sessionId
                            ? jsx('div', {
                              className: 'taskAsk placeholder',
                              children: '请先打开会话',
                            })
                            : null,
                      ],
                    }),
                  }),
                  jsx('div', {
                    className: 'taskAsk row',
                    children: jsx('button', {
                      type: 'button',
                      className: 'taskAsk primary',
                      disabled: !canSend,
                      'aria-label': '询问',
                      onClick: () => { void ask(draft) },
                      children: jsx('svg', {
                        viewBox: '0 0 16 16',
                        width: 16,
                        height: 16,
                        'aria-hidden': true,
                        children: jsx('path', { d: SEND_PATH, fill: 'currentColor' }),
                      }),
                    }),
                  }),
                ],
              }),
              jsx('p', {
                className: 'taskAsk note',
                children: '读取进行中回合 + 实时流 · 不打断主任务',
              }),
            ],
          }),
        ],
      })
    }

    function TaskAskTitle() {
      return jsx('span', { children: '旁路询问' })
    }

    function HeaderOpener() {
      ensureStyles()
      return jsx('button', {
        type: 'button',
        className: 'taskAsk headerBtn',
        title: '在右侧栏旁路询问当前任务（不打断）',
        onClick: () => {
          const open = HeaderOpener.openTab
          if (typeof open === 'function') open()
        },
        children: '旁路询问',
      })
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        HeaderOpener.openTab = () => {
          ctx.sidebarRight.openTab(TAB_KIND)
        }

        ctx.effect(
          () => ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            priority: 'extension',
            title: () => '旁路询问',
            guide: [{
              order: 40,
              title: () => '旁路询问',
              description: () => '只读询问当前任务进度，不打断主会话',
            }],
          }),
          'task-ask: tab type',
        )

        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            { name: 'sidebar.right.pane.tab', key: TAB_ID },
            TaskAskBody,
          ))

        ctx.slots.inject('sidebar.right.pane.tab.title', () =>
          ctx.slots.register(
            { name: 'sidebar.right.pane.tab.title', key: TAB_ID },
            TaskAskTitle,
          ))

        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register({
            name: 'conversation.session.header.actions',
            id: 'task-ask-open',
            order: 35,
          }, HeaderOpener))
      },
    }
  },
})
