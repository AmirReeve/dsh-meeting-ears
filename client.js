/**
 * Client half: a composer dock strip that starts/stops system-audio listening and
 * feeds merged utterances into the draft, submitting them when the composer is free.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-meeting-ears',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'meeting-ears'
    const POLL_MS = 300

    const zh = {
      title: '会议耳朵',
      start: '开始监听系统声音',
      stop: '停止监听',
      starting: '正在启动…',
      listening: '正在听系统声音',
      preparing: '正在准备本地语音模型…',
      unprepared: '本地语音模型尚未下载（约 240 MB），首次开始会自动下载',
      waiting: '等待对方说话…',
      hearing: '听到声音',
      idle: '未监听',
      error: '出错',
      pending: '待发送 {count} 条',
      insert: '插入',
      hint: '静音 1 秒后整句自动发到对话框',
      silence: '静音判定',
      device: '采集设备',
      deviceAuto: '跟随系统默认',
      downloading: '模型下载中 {percent}%（{done}/{total} MB）',
      modelFailed: '模型准备失败：{message}',
    }

    const en = {
      title: 'Meeting ears',
      start: 'Start listening to system audio',
      stop: 'Stop listening',
      starting: 'Starting…',
      listening: 'Listening to system audio',
      preparing: 'Preparing the local speech model…',
      unprepared: 'The local speech model is not downloaded yet (about 240 MB); starting will download it',
      waiting: 'Waiting for speech…',
      hearing: 'Speech detected',
      idle: 'Not listening',
      error: 'Error',
      pending: '{count} pending',
      insert: 'Insert',
      hint: 'A whole sentence is sent after 1 s of silence',
      silence: 'Silence window',
      device: 'Capture device',
      deviceAuto: 'Follow system default',
      downloading: 'Downloading the model {percent}% ({done}/{total} MB)',
      modelFailed: 'Model preparation failed: {message}',
    }

    const styles = {
      pill: {
        display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, padding: '0 8px',
        borderRadius: 12, cursor: 'pointer', font: 'inherit', fontSize: 11, lineHeight: 1,
        border: '1px solid var(--dsw-alias-border-weak, rgba(128,128,128,0.28))',
        background: 'transparent', color: 'inherit', opacity: 0.85,
      },
      row: {
        display: 'flex', alignItems: 'center', gap: 8, minHeight: 26, fontSize: 11,
        color: 'inherit', font: 'inherit', opacity: 0.9,
      },
      round: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 20, height: 20, padding: 0, borderRadius: 10, cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-weak, rgba(128,128,128,0.28))',
        background: 'transparent', color: 'inherit',
      },
      text: {
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 360,
        opacity: 0.75,
      },
      bars: { display: 'inline-flex', alignItems: 'flex-end', gap: 2, height: 12 },
      bar: { width: 2.5, borderRadius: 2, background: 'currentColor', opacity: 0.7 },
      action: {
        padding: '1px 7px', borderRadius: 9, cursor: 'pointer', font: 'inherit', fontSize: 11,
        border: '1px solid var(--dsw-alias-border-weak, rgba(128,128,128,0.28))',
        background: 'transparent', color: 'inherit',
      },
      failure: { color: '#d0553f', fontSize: 11 },
      select: {
        font: 'inherit', fontSize: 11, color: 'inherit', padding: '0 2px', borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-weak, rgba(128,128,128,0.28))',
        background: 'transparent', cursor: 'pointer', colorScheme: 'dark',
      },
      option: { color: '#1b1f24', backgroundColor: '#ffffff' },
    }

    function EarIcon({ size }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size || 14, height: size || 14, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', 'aria-hidden': true,
      },
        h('path', { d: 'M6 9a6 6 0 1 1 12 0c0 2.2-1.2 3.4-2.5 4.4C14.2 14.5 13 15.6 13 17a3 3 0 0 1-5.2 2' }),
        h('path', { d: 'M9.5 9a2.5 2.5 0 0 1 5 0c0 1.2-.7 1.8-1.5 2.4' }))
    }

    function Level({ value }) {
      const bars = [0.35, 0.6, 1, 0.75, 0.45]
      return h('span', { style: styles.bars, 'aria-hidden': true }, bars.map((weight, index) => h('span', {
        key: index,
        style: { ...styles.bar, height: Math.max(2, Math.round(12 * Math.min(1, value * 2.2) * weight)) },
      })))
    }

    function MeetingEars(props) {
      const { inputActions, locked, useInput, sessionId, start, stop, poll, configure, sent } = props
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const [view, setView] = React.useState({ phase: 'idle', level: 0, prep: 'unknown', device: '', error: '', autoSend: true })
      const [lastText, setLastText] = React.useState('')
      const [pending, setPending] = React.useState(0)
      const [tick, setTick] = React.useState(0)
      const cursor = React.useRef(-1)
      const queue = React.useRef([])
      const inflight = React.useRef(false)

      let input
      try {
        input = typeof useInput === 'function' ? useInput(state => state) : undefined
      } catch (_error) {
        input = undefined
      }
      const idle = input === undefined ? false : input.draft.trim() === '' && input.phase === 'plain'
      const idleRef = React.useRef(idle)
      idleRef.current = idle

      const busy = view.phase === 'listening' || view.phase === 'starting'
      const expanded = busy || view.phase === 'error' || pending > 0
      const prep = view.prep !== null && typeof view.prep === 'object'
        ? view.prep
        : { phase: typeof view.prep === 'string' ? view.prep : 'unknown' }
      const needsModel = ['unprepared', 'downloading', 'checking', 'loading', 'waking', 'cancelling'].includes(prep.phase)
      const prepText = () => {
        if (prep.phase === 'downloading') {
          const done = Number(prep.completedBytes) || 0
          const total = Number(prep.totalBytes) || 0
          const percent = total > 0 ? Math.floor(done * 100 / total) : 0
          const mb = value => (value / 1048576).toFixed(0)
          return t('downloading', { percent, done: mb(done), total: total > 0 ? mb(total) : '?' })
        }
        if (prep.phase === 'failed') return t('modelFailed', { message: prep.message || '' })
        return t('preparing')
      }

      React.useEffect(() => {
        cursor.current = -1
        queue.current = []
        setPending(0)
        setLastText('')
      }, [sessionId])

      React.useEffect(() => {
        let alive = true
        const run = async () => {
          if (inflight.current) return
          inflight.current = true
          try {
            const next = await poll(cursor.current)
            if (!alive) return
            setView(next)
            if (cursor.current < 0) {
              // Fresh subscriber: adopt the host baseline instead of replaying history.
              cursor.current = Number(next.latest) || 0
            } else {
              for (const segment of next.segments || []) {
                cursor.current = Math.max(cursor.current, segment.seq)
                setLastText(segment.text)
                queue.current.push({ seq: segment.seq, text: segment.text })
              }
            }
            setPending(queue.current.length)
            setTick(value => value + 1)
          } catch (_error) {
            // A dropped transport recovers on the next successful poll.
          } finally {
            inflight.current = false
          }
        }
        void run()
        const timer = setInterval(run, POLL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [poll])

      React.useEffect(() => {
        if (!inputActions || typeof inputActions.setDraft !== 'function' || locked || !view.autoSend || !idleRef.current) return
        const item = queue.current.shift()
        if (item === undefined) return
        inputActions.setDraft(item.text)
        inputActions.submit()
        setPending(queue.current.length)
        if (typeof sent === 'function') void sent({ seq: item.seq, chars: item.text.length }).catch(() => {})
      }, [tick, locked, inputActions, view.autoSend])

      const insertPending = () => {
        if (!inputActions || typeof inputActions.insertText !== 'function') return
        const span = inputActions.captureInsertion()
        if (!inputActions.insertText(queue.current.map(item => item.text).join('\n'), span)) return
        queue.current = []
        setPending(0)
      }

      const toggle = () => { if (busy) stop(); else start() }

      if (!expanded) {
        return h('div', { style: { display: 'flex' } },
          h('button', {
            type: 'button',
            style: styles.pill,
            title: needsModel ? prepText() : t('start'),
            'aria-label': needsModel ? prepText() : t('start'),
            onMouseDown: event => { event.preventDefault() },
            onClick: toggle,
          }, h(EarIcon, { size: 13 }), t('title')))
      }

      const device = String(view.device || '').replace(' [Loopback]', '')
      const silence = Number(view.silenceMs) || 1000
      const silenceOptions = [400, 600, 800, 1000, 1200, 1500, 1800, 2000, 2500, 3000]
      const pin = String(view.devicePin || '')
      const deviceOptions = ['', ...(Array.isArray(view.devices) ? view.devices : [])]
      if (pin !== '' && !deviceOptions.includes(pin)) deviceOptions.push(pin)
      const status = view.phase === 'error' ? `${t('error')}: ${view.error}`
        : view.phase === 'starting' ? prepText()
          : needsModel ? prepText()
            : `${view.level > 0.05 ? t('hearing') : t('waiting')}${device === '' ? '' : ` · ${device}`}`

      return h('div', { style: styles.row, 'data-meeting-ears': view.phase },
        h('button', { type: 'button', style: styles.round, title: t('stop'), 'aria-label': t('stop'), onClick: toggle },
          h('svg', { viewBox: '0 0 24 24', width: 10, height: 10, fill: 'currentColor', 'aria-hidden': true },
            h('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }))),
        busy ? h(Level, { value: view.level }) : h(EarIcon, { size: 13 }),
        h('span', { style: styles.text, title: lastText || view.device },
          view.phase === 'error' ? status : (lastText || status)),
        typeof configure === 'function'
          ? h('select', {
            value: String(silence),
            title: t('silence'),
            'aria-label': t('silence'),
            style: styles.select,
            onChange: event => { void configure({ silenceMs: Number(event.target.value) }) },
          }, silenceOptions.map(value => h('option', { key: value, value: String(value), style: styles.option },
            `${(value / 1000).toFixed(1)}s`)))
          : null,
        typeof configure === 'function'
          ? h('select', {
            value: pin,
            title: t('device'),
            'aria-label': t('device'),
            style: { ...styles.select, maxWidth: 160 },
            onChange: event => { void configure({ device: event.target.value }) },
          }, deviceOptions.map(value => h('option', { key: value || 'auto', value, style: styles.option },
            value === '' ? t('deviceAuto') : value.replace(' [Loopback]', ''))))
          : null,
        pending > 0
          ? h('button', { type: 'button', style: styles.action, onClick: insertPending },
            `${t('insert')} · ${t('pending', { count: pending })}`)
          : h('span', { style: styles.text }, view.phase === 'error' ? '' : t('hint')))
    }

    /** Keep a render failure visible instead of letting the slot entry vanish. */
    class Guard extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: '' }
      }

      static getDerivedStateFromError(error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }

      render() {
        if (this.state.error !== '') return h('span', { style: styles.failure }, `会议耳朵: ${this.state.error}`)
        return h(MeetingEars, this.props)
      }
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }))
        } catch (_error) {
          // Localized labels fall back to keys; a locale failure must not disable the plugin.
        }
        const call = async (endpoint, payload) => {
          const result = await ctx.connection.rpc.call('/api', 'meeting-ears', { endpoint, ...payload })
          if (!result.ok) throw new Error(result.error?.message ?? 'meeting ears request failed')
          return result.value
        }
        const actions = {
          start: () => call('start'),
          stop: () => call('stop'),
          poll: since => call('poll', { since }),
          configure: payload => call('configure', payload),
          sent: payload => call('sent', payload),
        }
        let mounted = false
        try {
          const pendingMount = ctx.slots.inject('conversation.composer.dock', () => {
            mounted = true
            return ctx.slots.register({
              name: 'conversation.composer.dock', id: 'meeting-ears', order: 20, locale: NS, inject: () => actions,
            }, Guard)
          })
          if (pendingMount !== undefined && typeof pendingMount.catch === 'function') {
            void pendingMount.catch((error) => {
              void call('poll', { since: 0, probe: `slot-error:${String(error && error.message || error).slice(0, 100)}` }).catch(() => {})
            })
          }
        } catch (error) {
          void call('poll', { since: 0, probe: `register-threw:${String(error && error.message || error).slice(0, 100)}` }).catch(() => {})
        }
        void call('poll', { since: 0, probe: mounted ? 'slot-registered' : 'apply-only' }).catch(() => {})
      },
    }
  },
})
