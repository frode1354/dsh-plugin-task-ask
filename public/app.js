(() => {
  const params = new URLSearchParams(location.search)
  let sessionId = params.get('session') || params.get('sessionId') || ''
  const embedded = params.get('embedded') === '1'
  if (embedded) document.documentElement.dataset.embedded = '1'
  /** @type {EventSource | null} */
  let source = null
  let asking = false

  const el = {
    select: document.getElementById('sessionSelect'),
    refresh: document.getElementById('refreshBtn'),
    phase: document.getElementById('phase'),
    agent: document.getElementById('agentStatus'),
    detail: document.getElementById('phaseDetail'),
    meta: document.getElementById('meta'),
    todos: document.getElementById('todos'),
    live: document.getElementById('live'),
    liveText: document.getElementById('liveText'),
    chat: document.getElementById('chat'),
    form: document.getElementById('askForm'),
    question: document.getElementById('question'),
    askBtn: document.getElementById('askBtn'),
  }

  function bubble(role, text, isError = false) {
    const div = document.createElement('div')
    div.className = `bubble ${role}${isError ? ' error' : ''}`
    const who = document.createElement('span')
    who.className = 'who'
    who.textContent = role === 'user' ? '你' : '观察助手'
    div.appendChild(who)
    if (role === 'bot') {
      const body = document.createElement('div')
      body.className = 'body'
      body.textContent = text
      div.appendChild(body)
    } else {
      div.appendChild(document.createTextNode(text))
    }
    el.chat.appendChild(div)
    el.chat.scrollTop = el.chat.scrollHeight
  }

  function renderSnapshot(snap) {
    if (!snap) return
    el.phase.textContent = snap.phase || '未知'
    el.agent.textContent = snap.agentStatus || 'unknown'
    el.agent.classList.toggle('running', snap.agentStatus === 'running')
    el.detail.textContent = snap.phaseDetail || ''
    el.meta.textContent = [
      snap.title ? `标题：${snap.title}` : null,
      `事件 ${snap.eventCount ?? 0}`,
      snap.turn != null ? `turn ${snap.turn}` : null,
      snap.step != null ? `step ${snap.step}` : null,
      snap.updatedAt ? `更新 ${new Date(snap.updatedAt).toLocaleTimeString()}` : null,
    ].filter(Boolean).join(' · ')

    el.todos.innerHTML = ''
    const todos = Array.isArray(snap.todos) ? snap.todos : []
    if (!todos.length) {
      const li = document.createElement('li')
      li.textContent = '暂无待办快照'
      li.style.color = 'var(--ink-soft)'
      el.todos.appendChild(li)
    } else {
      for (const todo of todos) {
        const li = document.createElement('li')
        li.textContent = todo.content
        if (todo.status === 'completed') li.className = 'done'
        if (todo.status === 'in_progress') li.className = 'active'
        el.todos.appendChild(li)
      }
    }

    if (snap.liveText) {
      el.live.hidden = false
      el.liveText.textContent = snap.liveText
    } else {
      el.live.hidden = true
      el.liveText.textContent = ''
    }
  }

  async function loadSessions() {
    const res = await fetch('/api/task-ask/sessions')
    const data = await res.json()
    const sessions = data.sessions || []
    el.select.innerHTML = ''
    if (!sessions.length) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = '暂无会话'
      el.select.appendChild(opt)
      return
    }
    for (const s of sessions) {
      const opt = document.createElement('option')
      opt.value = s.id
      const mark = s.agentStatus === 'running' ? '● ' : ''
      opt.textContent = `${mark}${s.title || s.id.slice(0, 8)}`
      el.select.appendChild(opt)
    }
    if (!sessionId || !sessions.some((s) => s.id === sessionId)) {
      sessionId = sessions[0].id
    }
    el.select.value = sessionId
  }

  function connect() {
    if (source) {
      source.close()
      source = null
    }
    if (!sessionId) {
      el.phase.textContent = '未选择会话'
      return
    }
    const url = new URL('/api/task-ask/events', location.origin)
    url.searchParams.set('sessionId', sessionId)
    source = new EventSource(url)
    source.addEventListener('snapshot', (ev) => {
      try {
        renderSnapshot(JSON.parse(ev.data))
      } catch {
        /* ignore malformed frames */
      }
    })
    source.onerror = () => {
      el.phase.textContent = '实时连接中断，稍后重试…'
    }
  }

  async function ask(question) {
    if (!sessionId || asking) return
    asking = true
    el.askBtn.disabled = true
    bubble('user', question)
    try {
      const res = await fetch('/api/task-ask/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, question }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      bubble('bot', data.answer)
    } catch (err) {
      bubble('bot', err instanceof Error ? err.message : String(err), true)
    } finally {
      asking = false
      el.askBtn.disabled = false
      el.question.focus()
    }
  }

  el.select.addEventListener('change', () => {
    sessionId = el.select.value
    const next = new URL(location.href)
    next.searchParams.set('session', sessionId)
    history.replaceState(null, '', next)
    connect()
  })

  el.refresh.addEventListener('click', async () => {
    await loadSessions()
    connect()
  })

  el.form.addEventListener('submit', (ev) => {
    ev.preventDefault()
    const q = el.question.value.trim()
    if (!q) return
    el.question.value = ''
    void ask(q)
  })

  el.question.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault()
      el.form.requestSubmit()
    }
  })

  document.querySelectorAll('.hints button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const q = btn.getAttribute('data-q')
      if (q) void ask(q)
    })
  })

  void (async () => {
    try {
      await loadSessions()
      connect()
      bubble('bot', '主任务继续跑。你可以随时问现在在干什么、做到哪一步了——这里只读，不打断。')
    } catch (err) {
      el.phase.textContent = '无法加载会话'
      bubble('bot', err instanceof Error ? err.message : String(err), true)
    }
  })()
})()
