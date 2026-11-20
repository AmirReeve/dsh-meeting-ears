/**
 * Client half: an ear button beside the composer controls, a compact live status
 * strip under the composer, and a settings panel on the plugin's detail page.
 */
window.__ModuleLoader__.load({
  id: 'dsh-meeting-ears',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'meeting-ears'
    const POLL_MS = 150
    /** My own sentences ride along with the next remote sentence, but not forever. */
    const CONTEXT_TTL_MS = 120000
    const CONTEXT_MAX_LINES = 6

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
      mic: '同时采集我的麦克风',
      micHelp: '把你自己说的话也转写进来，标成“我”；用扬声器时自动去掉回声',
      micDevice: '麦克风设备',
      micDeviceAuto: '跟随系统默认麦克风',
      onlyQuestions: '只把对方的问题发给我',
      onlyQuestionsHelp: '打开后，对方的陈述句只作为上下文；只有问句才触发发送',
      judge: '用模型判断是不是问题',
      judgeHelp: '比关键词准得多，代价是每句多一次小模型调用（约 0.3~0.8 秒）',
      judgeModel: '判断用的模型',
      judgeModelNone: '未选择（退回关键词规则）',
      refreshDevices: '刷新设备',
      autoSend: '自动发送',
      autoSendHelp: '关闭后逐句追加到输入框，不自动发送（自己按回车）',
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
      mic: 'Also capture my microphone',
      micHelp: 'Transcribes your own voice as “我”; speaker echo is dropped automatically',
      micDevice: 'Microphone',
      micDeviceAuto: 'Follow system default microphone',
      onlyQuestions: 'Send only questions from the other side',
      onlyQuestionsHelp: 'When on, statements become context and only questions trigger a send',
      judge: 'Use a model to decide what is a question',
      judgeHelp: 'Far more accurate than keywords; costs one small model call per sentence (0.3–0.8 s)',
      judgeModel: 'Judge model',
      judgeModelNone: 'None (fall back to keywords)',
      refreshDevices: 'Refresh devices',
      autoSend: 'Send automatically',
      autoSendHelp: 'When off, each sentence is appended to the draft without sending',
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
      const context = React.useRef([])
      const signatureRef = React.useRef('')
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
        if (lockedRef.current) return
        if (store.get().view?.autoSend) {
          if (!idleRef.current) return
          // My own speech never sends on its own: it becomes context that rides
          // along with the next sentence from the other side.
          let item
          while (queue.current.length > 0) {
            const head = queue.current[0]
            if (!head.trigger) {
              context.current.push(head)
              queue.current.shift()
              continue
            }
            item = queue.current.shift()
            break
          }
          store.set({ pending: queue.current.length, pendingTexts: queue.current.map(entry => entry.text) })
          if (item === undefined) return
          const cutoff = Date.now() - CONTEXT_TTL_MS
          const fresh = context.current.filter(entry => entry.at >= cutoff).slice(-CONTEXT_MAX_LINES)
          context.current = []
          const lines = [...fresh.map(entry => entry.text), item.text]
          inputActions.setDraft(lines.join('\n'))
          inputActions.submit()
          if (typeof sent === 'function') void sent({ seq: item.seq, chars: item.text.length }).catch(() => {})
          return
        }
        // Auto-send off: append each finished sentence to the draft as it arrives,
        // so the composer reads like a live transcript the user submits themselves.
        if (typeof inputActions.insertText !== 'function') return
        const pendingAll = [...context.current, ...queue.current]
        context.current = []
        queue.current = []
        for (const item of pendingAll) {
          const span = inputActions.captureInsertion()
          if (!inputActions.insertText(item.text, span)) {
            queue.current.push(item)
            break
          }
        }
        store.set({ pending: queue.current.length, pendingTexts: queue.current.map(entry => entry.text) })
      }

      React.useEffect(() => {
        cursor.current = -1
        queue.current = []
        context.current = []
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
                queue.current.push({
                  seq: segment.seq,
                  text: segment.text,
                  source: segment.source,
                  // Only an explicit trigger may wake the agent; a segment from an
                  // older Host without the flag stays context.
                  trigger: segment.trigger === true,
                  at: Date.now(),
                })
              }
            }
            const signature = [
              next.phase, next.device, next.micDevice, next.error, next.latest,
              Math.round((Number(next.level) || 0) * 10), next.mic, next.autoSend,
              next.silenceMs, next.devicePin, next.micPin,
            ].join('|')
            const patch = {}
            if (signatureRef.current !== signature) {
              signatureRef.current = signature
              patch.view = next
            }
            if (latest !== '') patch.lastText = latest
            if (queue.current.length !== store.get().pending) {
              patch.pending = queue.current.length
              patch.pendingTexts = queue.current.map(entry => entry.text)
            }
            if (Object.keys(patch).length > 0) store.set(patch)
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
      const { poll, configure, devices, models } = props
      const t = typeof props.t === 'function' ? props.t : key => key
      const [view, setView] = React.useState(null)
      const [speakers, setSpeakers] = React.useState([])
      const [microphones, setMicrophones] = React.useState([])
      const [error, setError] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [saved, setSaved] = React.useState(false)
      const [draft, setDraft] = React.useState({
        silenceMs: 1000, device: '', mic: true, micDevice: '', autoSend: true,
        onlyQuestions: true, judge: false, judgeProvider: '', judgeModel: '', language: 'zh',
      })
      const [modelOptions, setModelOptions] = React.useState([])

      const apply = next => {
        setView(next)
        setDraft({
          silenceMs: Number(next.silenceMs) || 1000,
          device: String(next.devicePin || ''),
          mic: next.mic !== false,
          micDevice: String(next.micPin || ''),
          autoSend: next.autoSend !== false,
          onlyQuestions: next.onlyQuestions !== false,
          judge: next.judge === true,
          judgeProvider: String(next.judgeProvider || ''),
          judgeModel: String(next.judgeModel || ''),
          language: String(next.language || 'zh'),
        })
        if (Array.isArray(next.devices) && next.devices.length > 0) setSpeakers(next.devices)
        if (Array.isArray(next.microphones) && next.microphones.length > 0) setMicrophones(next.microphones)
      }

      const refresh = async () => {
        try {
          const list = await devices()
          if (Array.isArray(list?.speakers)) setSpeakers(list.speakers)
          if (Array.isArray(list?.microphones)) setMicrophones(list.microphones)
        } catch (_failure) {
          // Keep the previous list.
        }
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
          if (alive) await refresh()
          if (alive && typeof models === 'function') {
            try {
              const list = await models()
              if (alive && Array.isArray(list)) setModelOptions(list)
            } catch (_failure) {
              // Keyword mode stays available without a model list.
            }
          }
        })()
        return () => { alive = false }
      }, [poll, devices, models])

      const save = async () => {
        setSaving(true)
        setError('')
        try {
          const next = await configure({
            silenceMs: Number(draft.silenceMs) || 1000,
            device: draft.device,
            mic: draft.mic,
            micDevice: draft.micDevice,
            autoSend: draft.autoSend,
            onlyQuestions: draft.onlyQuestions,
            judge: draft.judge,
            judgeProvider: draft.judgeProvider,
            judgeModel: draft.judgeModel,
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

      const speakerOptions = ['', ...speakers]
      if (draft.device !== '' && !speakerOptions.includes(draft.device)) speakerOptions.push(draft.device)
      const micOptions = ['', ...microphones]
      if (draft.micDevice !== '' && !micOptions.includes(draft.micDevice)) micOptions.push(draft.micDevice)
      const selectStyle = { ...styles.input, maxWidth: 320, colorScheme: 'dark' }
      const optionStyle = { color: '#1b1f24', backgroundColor: '#ffffff' }

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
              style: selectStyle,
              value: draft.device,
              onChange: event => setDraft({ ...draft, device: event.target.value }),
            }, speakerOptions.map(value => h('option', { key: value || 'auto', value, style: optionStyle },
              value === '' ? t('deviceAuto') : value.replace(' [Loopback]', '')))),
            h('button', { type: 'button', style: styles.action, onClick: refresh }, t('refreshDevices')))),
        h('div', { style: styles.field },
          h('label', { style: styles.inline },
            h('input', {
              type: 'checkbox', checked: draft.mic,
              onChange: event => setDraft({ ...draft, mic: event.target.checked }),
            }),
            h('span', { style: styles.label }, t('mic'))),
          h('span', { style: styles.help }, t('micHelp'))),
        draft.mic
          ? h('div', { style: styles.field },
            h('span', { style: styles.label }, t('micDevice')),
            h('select', {
              style: selectStyle,
              value: draft.micDevice,
              onChange: event => setDraft({ ...draft, micDevice: event.target.value }),
            }, micOptions.map(value => h('option', { key: value || 'auto', value, style: optionStyle },
              value === '' ? t('micDeviceAuto') : value))))
          : null,
        h('div', { style: styles.field },
          h('label', { style: styles.inline },
            h('input', {
              type: 'checkbox', checked: draft.onlyQuestions,
              onChange: event => setDraft({ ...draft, onlyQuestions: event.target.checked }),
            }),
            h('span', { style: styles.label }, t('onlyQuestions'))),
          h('span', { style: styles.help }, t('onlyQuestionsHelp'))),
        h('div', { style: styles.field },
          h('label', { style: styles.inline },
            h('input', {
              type: 'checkbox', checked: draft.judge,
              onChange: event => setDraft({ ...draft, judge: event.target.checked }),
            }),
            h('span', { style: styles.label }, t('judge'))),
          h('span', { style: styles.help }, t('judgeHelp'))),
        draft.judge
          ? h('div', { style: styles.field },
            h('span', { style: styles.label }, t('judgeModel')),
            h('select', {
              style: selectStyle,
              value: draft.judgeProvider !== '' && draft.judgeModel !== ''
                ? `${draft.judgeProvider}|${draft.judgeModel}`
                : '',
              onChange: event => {
                const [provider, model] = String(event.target.value).split('|')
                setDraft({ ...draft, judgeProvider: provider || '', judgeModel: model || '' })
              },
            }, [
              h('option', { key: 'none', value: '', style: optionStyle }, t('judgeModelNone')),
              ...modelOptions.map(entry => h('option', {
                key: `${entry.provider}|${entry.model}`,
                value: `${entry.provider}|${entry.model}`,
                style: optionStyle,
              }, `${entry.name} · ${entry.provider}`)),
            ]))
          : null,
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
          }, ['zh', 'en', 'yue', 'ja', 'ko', 'auto'].map(value => h('option', { key: value, value, style: optionStyle }, value)))),
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
          models: () => call('models'),
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
          name: 'plugins.bundle.config', key: 'dsh-meeting-ears', locale: NS, inject: () => actions,
        }, GuardedSettings))
        void call('poll', { since: -1 }).catch(() => {})
      },
    }
  },
})
