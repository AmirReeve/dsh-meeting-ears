/**
 * Client half: an ear button beside the composer controls, a compact live status
 * strip under the composer, and a settings panel on the plugin's detail page.
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
      waiting: '等待对方说话…',
      hearing: '听到声音',
      error: '出错',
      pending: '待发送 {count} 条',
      insert: '插入',
      downloading: '模型下载中 {percent}%（{done}/{total} MB）',
      modelFailed: '模型准备失败：{message}',
      settingsTitle: '监听设置',
      silence: '静音判定（毫秒）',
      silenceHelp: '对方说完后停顿多久算一句结束，200–10000 ms',
      device: '采集设备',
      deviceAuto: '跟随系统默认',
      refreshDevices: '刷新设备',
      autoSend: '自动发送',
      autoSendHelp: '关闭后只转写，需手动点“插入”',
      language: '识别语言',
      save: '保存',
      saved: '已保存',
      saving: '保存中…',
      loadFailed: '读取设置失败：{message}',
    }

    const en = {
      title: 'Meeting ears',
      start: 'Start listening to system audio',
      stop: 'Stop listening',
      starting: 'Starting…',
      listening: 'Listening to system audio',
      preparing: 'Preparing the local speech model…',
      waiting: 'Waiting for speech…',
      hearing: 'Speech detected',
      error: 'Error',
      pending: '{count} pending',
      insert: 'Insert',
      downloading: 'Downloading the model {percent}% ({done}/{total} MB)',
      modelFailed: 'Model preparation failed: {message}',
      settingsTitle: 'Listening settings',
      silence: 'Silence window (ms)',
      silenceHelp: 'Silence after speech that ends a sentence, 200–10000 ms',
      device: 'Capture device',
      deviceAuto: 'Follow system default',
      refreshDevices: 'Refresh devices',
      autoSend: 'Send automatically',
      autoSendHelp: 'When off, transcripts wait for Insert',
      language: 'Recognition language',
      save: 'Save',
      saved: 'Saved',
      saving: 'Saving…',
      loadFailed: 'Cannot read settings: {message}',
    }

    const styles = {
      trigger: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, padding: 0, borderRadius: 14, cursor: 'pointer',
        border: '1px solid transparent', background: 'transparent', color: 'inherit',
      },
      triggerOn: {
        borderColor: 'var(--dsw-alias-accent, #d0553f)',
        color: 'var(--dsw-alias-accent, #d0553f)',
      },
      row: {
        display: 'flex', alignItems: 'center', gap: 8, minHeight: 26, fontSize: 11,
        color: 'inherit', font: 'inherit', opacity: 0.9,
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
      section: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0', fontSize: 13 },
      field: { display: 'flex', flexDirection: 'column', gap: 4 },
      label: { fontSize: 13, fontWeight: 500 },
      help: { fontSize: 11, opacity: 0.6 },
      input: {
        font: 'inherit', fontSize: 13, padding: '4px 8px', borderRadius: 6, maxWidth: 200,
        border: '1px solid var(--dsw-alias-border-weak, rgba(128,128,128,0.28))',
        background: 'transparent', color: 'inherit',
      },
      inline: { display: 'flex', alignItems: 'center', gap: 8 },
      primary: {
        font: 'inherit', fontSize: 13, padding: '5px 14px', borderRadius: 8, cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-weak, rgba(128,128,128,0.28))',
        background: 'transparent', color: 'inherit', alignSelf: 'flex-start',
      },
    }

    /** One tiny shared snapshot so the three surfaces poll a single time. */
    const store = (() => {
      let state = { view: null, lastText: '', pending: 0, pendingTexts: [] }
      const listeners = new Set()
      return {
        get: () => state,
        set(patch) {
          state = { ...state, ...patch }
          for (const listener of [...listeners]) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    })()

    const useSnapshot = () => React.useSyncExternalStore(store.subscribe, store.get)

    function EarIcon({ size }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size || 16, height: size || 16, fill: 'none',
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

    const prepOf = view => {
      if (view === null || view === undefined) return { phase: 'unknown' }
      return view.prep !== null && typeof view.prep === 'object'
        ? view.prep
        : { phase: typeof view.prep === 'string' ? view.prep : 'unknown' }
    }

    const needsModel = phase => ['unprepared', 'downloading', 'checking', 'loading', 'waking', 'cancelling'].includes(phase)

    const prepText = (t, prep) => {
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

    /** Compact ear toggle in the composer tool row; also owns polling and auto-send. */
    function Toolbar(props) {
      const { start, stop, poll, sent, inputActions, locked, useInput, sessionId } = props
      const t = typeof props.t === 'function' ? props.t : key => key
      const snapshot = useSnapshot()
      const view = snapshot.view
      const cursor = React.useRef(-1)
      const queue = React.useRef([])
      const inflight = React.useRef(false)
      const lockedRef = React.useRef(locked)
      lockedRef.current = locked

      let input
      try {
        input = typeof useInput === 'function' ? useInput(state => state) : undefined
      } catch (_error) {
        input = undefined
      }
      const idleRef = React.useRef(false)
      idleRef.current = input === undefined ? false : input.draft.trim() === '' && input.phase === 'plain'

      const flush = () => {
        if (!inputActions || typeof inputActions.setDraft !== 'function') return
        if (lockedRef.current || !idleRef.current) return
        if (!store.get().view?.autoSend) return
        const item = queue.current.shift()
        if (item === undefined) return
        inputActions.setDraft(item.text)
        inputActions.submit()
        store.set({ pending: queue.current.length, pendingTexts: queue.current.map(entry => entry.text) })
        if (typeof sent === 'function') void sent({ seq: item.seq, chars: item.text.length }).catch(() => {})
      }

      React.useEffect(() => {
        cursor.current = -1
        queue.current = []
        store.set({ pending: 0, lastText: '' })
      }, [sessionId])

      React.useEffect(() => {
        let alive = true
        const run = async () => {
          if (inflight.current) return
          inflight.current = true
          try {
            const next = await poll(cursor.current)
            if (!alive) return
            let latest = ''
            if (cursor.current < 0) {
              cursor.current = Number(next.latest) || 0
            } else {
              for (const segment of next.segments || []) {
                cursor.current = Math.max(cursor.current, segment.seq)
                latest = segment.text
                queue.current.push({ seq: segment.seq, text: segment.text })
              }
            }
            store.set({
              view: next,
              lastText: latest !== '' ? latest : store.get().lastText,
              pending: queue.current.length,
              pendingTexts: queue.current.map(entry => entry.text),
            })
            flush()
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

      const busy = view !== null && (view.phase === 'listening' || view.phase === 'starting')
      const prep = prepOf(view)
      const title = view === null ? t('start')
        : view.phase === 'error' ? `${t('error')}: ${view.error}`
          : busy ? `${t('listening')}${view.device ? ` · ${String(view.device).replace(' [Loopback]', '')}` : ''}`
            : needsModel(prep.phase) ? prepText(t, prep) : t('start')

      return h('button', {
        type: 'button',
        style: busy ? { ...styles.trigger, ...styles.triggerOn } : styles.trigger,
        title,
        'aria-label': title,
        'aria-pressed': busy,
        onMouseDown: event => { event.preventDefault() },
        onClick: () => { if (busy) stop(); else start() },
      }, h(EarIcon, { size: 17 }))
    }

    /** Live status strip under the composer; disappears when nothing is happening. */
    function Dock(props) {
      const { inputActions, stop } = props
      const t = typeof props.t === 'function' ? props.t : key => key
      const snapshot = useSnapshot()
      const view = snapshot.view
      if (view === null) return null

      const busy = view.phase === 'listening' || view.phase === 'starting'
      const pending = snapshot.pending
      if (!busy && view.phase !== 'error' && pending === 0) return null

      const prep = prepOf(view)
      const device = String(view.device || '').replace(' [Loopback]', '')
      const status = view.phase === 'error' ? `${t('error')}: ${view.error}`
        : view.phase === 'starting' || needsModel(prep.phase) ? prepText(t, prep)
          : `${view.level > 0.05 ? t('hearing') : t('waiting')}${device === '' ? '' : ` · ${device}`}`

      const insertPending = () => {
        if (!inputActions || typeof inputActions.insertText !== 'function') return
        const texts = snapshot.pendingTexts || []
        if (texts.length === 0) return
        const span = inputActions.captureInsertion()
        if (inputActions.insertText(texts.join('\n'), span)) store.set({ pending: 0, pendingTexts: [] })
      }

      return h('div', { style: styles.row, 'data-meeting-ears': view.phase },
        h('button', { type: 'button', style: styles.action, title: t('stop'), onClick: () => stop() },
          h('svg', { viewBox: '0 0 24 24', width: 10, height: 10, fill: 'currentColor', 'aria-hidden': true },
            h('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }))),
        busy ? h(Level, { value: view.level }) : h(EarIcon, { size: 13 }),
        h('span', { style: styles.text, title: snapshot.lastText || view.device },
          snapshot.lastText || status),
        pending > 0
          ? h('button', { type: 'button', style: styles.action, onClick: insertPending },
            `${t('insert')} · ${t('pending', { count: pending })}`)
          : null)
    }

    /** Settings panel rendered on the bundle detail page. */
    function SettingsPanel(props) {
      const { poll, configure, devices } = props
      const t = typeof props.t === 'function' ? props.t : key => key
      const [view, setView] = React.useState(null)
      const [options, setOptions] = React.useState([])
      const [error, setError] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [saved, setSaved] = React.useState(false)
      const [draft, setDraft] = React.useState({ silenceMs: 1000, device: '', autoSend: true, language: 'zh' })

      const apply = next => {
        setView(next)
        setDraft({
          silenceMs: Number(next.silenceMs) || 1000,
          device: String(next.devicePin || ''),
          autoSend: next.autoSend !== false,
          language: String(next.language || 'zh'),
        })
        if (Array.isArray(next.devices) && next.devices.length > 0) setOptions(next.devices)
      }

      React.useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const next = await poll(-1)
            if (alive) apply(next)
          } catch (failure) {
            if (alive) setError(t('loadFailed', { message: String(failure && failure.message || failure) }))
          }
          try {
            const list = await devices()
            if (alive && Array.isArray(list)) setOptions(list)
          } catch (_failure) {
            // The stored list stays usable.
          }
        })()
        return () => { alive = false }
      }, [poll, devices])

      const save = async () => {
        setSaving(true)
        setError('')
        try {
          const next = await configure({
            silenceMs: Number(draft.silenceMs) || 1000,
            device: draft.device,
            autoSend: draft.autoSend,
            language: draft.language,
          })
          apply(next)
          setSaved(true)
          setTimeout(() => setSaved(false), 2000)
        } catch (failure) {
          setError(String(failure && failure.message || failure))
        } finally {
          setSaving(false)
        }
      }

      const deviceOptions = ['', ...options]
      if (draft.device !== '' && !deviceOptions.includes(draft.device)) deviceOptions.push(draft.device)

      return h('div', { style: styles.section },
        h('div', { style: styles.field },
          h('span', { style: styles.label }, t('silence')),
          h('input', {
            type: 'number', min: 200, max: 10000, step: 100,
            style: styles.input,
            value: String(draft.silenceMs),
            onChange: event => setDraft({ ...draft, silenceMs: Number(event.target.value) }),
          }),
          h('span', { style: styles.help }, t('silenceHelp'))),
        h('div', { style: styles.field },
          h('span', { style: styles.label }, t('device')),
          h('div', { style: styles.inline },
            h('select', {
              style: { ...styles.input, maxWidth: 320, colorScheme: 'dark' },
              value: draft.device,
              onChange: event => setDraft({ ...draft, device: event.target.value }),
            }, deviceOptions.map(value => h('option', {
              key: value || 'auto', value, style: { color: '#1b1f24', backgroundColor: '#ffffff' },
            }, value === '' ? t('deviceAuto') : value.replace(' [Loopback]', '')))),
            h('button', {
              type: 'button', style: styles.action,
              onClick: async () => {
                try {
                  const list = await devices()
                  if (Array.isArray(list)) setOptions(list)
                } catch (_failure) {
                  // Keep the previous list.
                }
              },
            }, t('refreshDevices')))),
        h('div', { style: styles.field },
          h('label', { style: styles.inline },
            h('input', {
              type: 'checkbox', checked: draft.autoSend,
              onChange: event => setDraft({ ...draft, autoSend: event.target.checked }),
            }),
            h('span', { style: styles.label }, t('autoSend'))),
          h('span', { style: styles.help }, t('autoSendHelp'))),
        h('div', { style: styles.field },
          h('span', { style: styles.label }, t('language')),
          h('select', {
            style: { ...styles.input, maxWidth: 200, colorScheme: 'dark' },
            value: draft.language,
            onChange: event => setDraft({ ...draft, language: event.target.value }),
          }, ['zh', 'en', 'yue', 'ja', 'ko', 'auto'].map(value => h('option', {
            key: value, value, style: { color: '#1b1f24', backgroundColor: '#ffffff' },
          }, value)))),
        h('div', { style: styles.inline },
          h('button', { type: 'button', style: styles.primary, disabled: saving, onClick: save },
            saving ? t('saving') : t('save')),
          saved ? h('span', { style: styles.help }, t('saved')) : null),
        error !== '' ? h('span', { style: styles.failure }, error) : null)
    }

    /** Keep a render failure visible instead of letting a slot entry vanish. */
    const guard = Component => class Guard extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: '' }
      }

      static getDerivedStateFromError(error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }

      render() {
        if (this.state.error !== '') return h('span', { style: styles.failure }, `会议耳朵: ${this.state.error}`)
        return h(Component, this.props)
      }
    }

    const GuardedToolbar = guard(Toolbar)
    const GuardedDock = guard(Dock)
    const GuardedSettings = guard(SettingsPanel)

    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }))
        } catch (_error) {
          // Localized labels fall back to keys.
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
          devices: () => call('devices'),
          sent: payload => call('sent', payload),
        }
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right', id: 'meeting-ears-trigger', order: 20, locale: NS, inject: () => actions,
        }, GuardedToolbar))
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'meeting-ears-status', order: 20, locale: NS, inject: () => actions,
        }, GuardedDock))
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: '@local/dsh-meeting-ears', locale: NS, inject: () => actions,
        }, GuardedSettings))
        void call('poll', { since: -1 }).catch(() => {})
      },
    }
  },
})
