/** Host half: capture system audio, transcribe it locally, expose the transcript to the composer UI. */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'meeting-ears'

const here = dirname(fileURLToPath(import.meta.url))
const HELPER = join(here, 'helper', 'capture_helper.py')
const MAX_SEGMENTS = 40

/** Text used for echo comparison: lowercase, no labels, no punctuation or spaces. */
const normalize = text => String(text)
  .replace(/^(对方|我)：/, '')
  .replace(/[\s，。！？、,.!?;；:：""''……\-—~～()（）\[\]【】]/g, '')
  .toLowerCase()

/** Dice coefficient over character bigrams; 1 means identical. */
const similarity = (a, b) => {
  if (a === b) return 1
  if (a === '' || b === '') return 0
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length)
  const grams = value => {
    const set = new Set()
    for (let index = 0; index < value.length - 1; index += 1) set.add(value.slice(index, index + 2))
    return set
  }
  const first = grams(a)
  const second = grams(b)
  if (first.size === 0 || second.size === 0) return 0
  let hits = 0
  for (const gram of first) if (second.has(gram)) hits += 1
  return (2 * hits) / (first.size + second.size)
}

/** Fraction of the shorter utterance that the two time ranges share. */
const overlapOf = (a, b) => {
  const start = Math.max(Number(a.startedAt) || 0, Number(b.startedAt) || 0)
  const end = Math.min(Number(a.endedAt) || 0, Number(b.endedAt) || 0)
  if (end <= start) return 0
  const shorter = Math.min((a.endedAt || 0) - (a.startedAt || 0), (b.endedAt || 0) - (b.startedAt || 0))
  return shorter <= 0 ? 0 : (end - start) / shorter
}

const ECHO_OVERLAP = 0.5
const ECHO_SIMILARITY = 0.75

/** Back-channel noises that carry no content and should never reach the agent. */
const FILLERS = new Set([
  '嗯', '嗯嗯', '嗯嗯嗯', '啊', '哦', '呃', '额', '唉', '诶',
  '对', '对对', '对的对的', '好', '好的', '好嘞', '行', '是', '是的', '是的呢',
  'ok', 'okay', 'hmm', 'mm', '那个', '这个', '然后', '就是',
])

const isFiller = text => {
  const normalized = normalize(text)
  if (normalized === '') return true
  if (FILLERS.has(normalized)) return true
  if (normalized.length <= 3 && /^[嗯啊哦呃额对好行是呀哈诶唉]+$/.test(normalized)) return true
  return false
}

/** Heuristics that decide whether a sentence is worth waking the agent for. */
const QUESTION_END = /[？?]\s*$/
const QUESTION_TAIL = /(吗|呢|嘛|么|没有|对不对|是不是|好不好|行不行)[。.!！]?\s*$/
const QUESTION_WORDS = /(什么|怎么|为什么|为啥|哪个|哪些|哪里|哪儿|谁|多少|多久|几点|几个|几种|是否|能否|能不能|可不可以|会不会|有没有|要不要|如何|请问|介绍一下|谈谈|说说)/
const EN_QUESTION_START = /^(what|why|how|when|where|who|which|do|does|did|is|are|can|could|would|should|have|has|will)\b/i

const isQuestion = text => {
  const trimmed = String(text).trim()
  if (trimmed.length < 4) return false
  if (QUESTION_END.test(trimmed) || QUESTION_TAIL.test(trimmed)) return true
  if (QUESTION_WORDS.test(trimmed)) return true
  return EN_QUESTION_START.test(trimmed)
}

/**
 * Listen to the default output device and turn speech into transcript lines.
 * @param ctx - Host context.
 * @param config - row config from cordis.patch.yml.
 */
export function apply(ctx, config = {}) {
  const options = {
    pythonPath: config.pythonPath || 'python',
    helperPath: config.helperPath || HELPER,
    silenceMs: Number(config.silenceMs ?? 1800),
    maxUtteranceMs: Number(config.maxUtteranceMs ?? 45000),
    language: config.language || 'zh',
    providerId: config.providerId || 'sensevoice-local',
    autoSend: config.autoSend !== false,
    device: typeof config.device === 'string' ? config.device : '',
    mic: config.mic !== false,
    micDevice: typeof config.micDevice === 'string' ? config.micDevice : '',
    onlyQuestions: config.onlyQuestions !== false,
    judge: config.judge === true,
    judgeProvider: typeof config.judgeProvider === 'string' ? config.judgeProvider : '',
    judgeModel: typeof config.judgeModel === 'string' ? config.judgeModel : '',
  }
  /** Profile entry id used by the settings service; absent when mounted without the Loader. */
  const entryId = ctx.fiber?.entry?.options?.id

  // The settings service cannot address this bundle's row, so remember the user's
  // choices in the plugin directory and prefer them over the patch defaults.
  const statePath = join(here, '.state.json')
  try {
    const saved = JSON.parse(readFileSync(statePath, 'utf8'))
    if (Number.isFinite(saved.silenceMs)) options.silenceMs = Math.round(saved.silenceMs)
    if (typeof saved.device === 'string') options.device = saved.device
    if (typeof saved.micDevice === 'string') options.micDevice = saved.micDevice
    if (typeof saved.mic === 'boolean') options.mic = saved.mic
    if (typeof saved.autoSend === 'boolean') options.autoSend = saved.autoSend
    if (typeof saved.language === 'string') options.language = saved.language
    if (typeof saved.onlyQuestions === 'boolean') options.onlyQuestions = saved.onlyQuestions
    if (typeof saved.judge === 'boolean') options.judge = saved.judge
    if (typeof saved.judgeProvider === 'string') options.judgeProvider = saved.judgeProvider
    if (typeof saved.judgeModel === 'string') options.judgeModel = saved.judgeModel
  } catch (_error) {
    // First run: patch defaults apply.
  }

  const saveState = () => {
    try {
      writeFileSync(statePath, JSON.stringify({
        silenceMs: options.silenceMs,
        device: options.device,
        mic: options.mic,
        micDevice: options.micDevice,
        autoSend: options.autoSend,
        language: options.language,
        onlyQuestions: options.onlyQuestions,
        judge: options.judge,
        judgeProvider: options.judgeProvider,
        judgeModel: options.judgeModel,
      }, null, 2))
    } catch (error) {
      console.warn('[meeting-ears] cannot write .state.json:', error)
    }
  }

  const state = {
    phase: 'idle',
    device: '',
    devices: [],
    microphones: [],
    micDevice: '',
    error: '',
    level: 0,
    systemLevel: 0,
    micLevel: 0,
    prep: 'unknown',
    autoSend: options.autoSend,
    segments: [],
  }

  ctx.inject(['connection', 'speechToText', 'webServer'], (scope) => {
    let child
    let stopped = true
    let buffer = ''
    let queue = Promise.resolve()
    let seq = 0
    let waitTimer
    const requests = new AbortController()

    const speech = scope.speechToText
    let lastLevelNote = 0

    const note = (text) => {
      try {
        appendFileSync(join(here, '.debug.log'), `${new Date().toISOString()} ${text}\n`)
      } catch (_error) {
        // Diagnostics are optional.
      }
    }

    /** Save changed settings into this plugin's profile entry so they survive a restart. */
    const persist = async (patch) => {
      const settings = scope.get('settings')
      if (settings === undefined || entryId === undefined) return
      try {
        await settings.update(entryId, patch)
      } catch (error) {
        note(`settings persist failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    /** Enumerate capture endpoints on demand (used by the settings page). */
    const listDevices = async () => {
      const result = spawnSync(options.pythonPath, ['-u', options.helperPath, '--list-devices'],
        { encoding: 'utf8', timeout: 20000, windowsHide: true })
      if (result.status === 0 && typeof result.stdout === 'string') {
        for (const line of result.stdout.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('{')) continue
          try {
            const parsed = JSON.parse(trimmed)
            if (Array.isArray(parsed.speakers)) {
              state.devices = parsed.speakers
              if (Array.isArray(parsed.microphones)) state.microphones = parsed.microphones
              return { speakers: state.devices, microphones: state.microphones }
            }
          } catch (_error) {
            // Ignore malformed lines.
          }
        }
      }
      return { speakers: state.devices, microphones: state.microphones }
    }

    let modelCache = { at: 0, items: [] }

    /** Every provider/model route the Host can call, for the settings dropdown. */
    const listModels = async () => {
      if (Date.now() - modelCache.at < 60000 && modelCache.items.length > 0) return modelCache.items
      const llm = scope.get('llm')
      if (llm === undefined) return []
      const items = []
      for (const provider of llm.listProviders()) {
        try {
          const models = await llm.listModels(provider.id)
          for (const model of models) {
            items.push({ provider: provider.id, model: model.id, name: model.name || model.id })
          }
        } catch (_error) {
          // A provider that cannot enumerate models simply contributes none.
        }
      }
      modelCache = { at: Date.now(), items }
      return items
    }

    /**
     * Ask a model whether a sentence is a question to the candidate.
     * @returns true/false, or undefined when the model cannot answer.
     */
    const judgeQuestion = async (text, contextLines) => {
      const llm = scope.get('llm')
      if (llm === undefined || options.judgeProvider === '' || options.judgeModel === '') return undefined
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      try {
        const prompt = [
          '你在帮我判断面试实时转录里的最后一句话。',
          '判断它是不是面试官在向候选人提问、或要求候选人回答/说明/操作。',
          '闲聊、附和、陈述事实、宣布流程都不算。',
          '只输出一个汉字：是 或 否。',
          '',
          ...contextLines.map(line => `前文：${line}`),
          `最后一句：${text}`,
        ].join('\n')
        let output = ''
        for await (const chunk of llm.stream({
          provider: options.judgeProvider,
          model: options.judgeModel,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          signal: controller.signal,
        })) {
          if (chunk.type === 'text-delta') output += chunk.text
          else if (chunk.type === 'finish') break
        }
        if (output.includes('是')) return true
        if (output.includes('否')) return false
        return undefined
      } catch (error) {
        note(`judge failed: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      } finally {
        clearTimeout(timer)
      }
    }

    const prepPhase = () => {
      try {
        const provider = speech.snapshot().providers.find(item => item.id === options.providerId)
        return provider?.preparation?.phase ?? 'unknown'
      } catch (_error) {
        return 'unknown'
      }
    }

    const prepDetail = () => {
      try {
        const provider = speech.snapshot().providers.find(item => item.id === options.providerId)
        const preparation = provider?.preparation
        if (preparation === undefined) return { phase: 'unknown' }
        return {
          phase: preparation.phase,
          completedBytes: preparation.completedBytes,
          totalBytes: preparation.totalBytes,
          message: preparation.message,
        }
      } catch (_error) {
        return { phase: 'unknown' }
      }
    }

    const describe = () => {
      const prep = prepDetail()
      state.prep = prep.phase
      return {
        phase: state.phase,
        device: state.device,
        devices: state.devices,
        microphones: state.microphones,
        micDevice: state.micDevice,
        mic: options.mic,
        micPin: options.micDevice,
        error: state.error,
        level: state.level,
        systemLevel: state.systemLevel,
        micLevel: state.micLevel,
        prep,
        silenceMs: options.silenceMs,
        devicePin: options.device,
        language: options.language,
        pythonPath: options.pythonPath,
        latest: state.segments.length === 0 ? 0 : state.segments[state.segments.length - 1].seq,
        autoSend: state.autoSend,
        onlyQuestions: options.onlyQuestions,
        judge: options.judge,
        judgeProvider: options.judgeProvider,
        judgeModel: options.judgeModel,
        segments: state.segments,
      }
    }

    /**
     * Append one transcript, dropping the microphone copy of a sentence that the
     * loopback already captured (speaker echo), and keeping speaker labels.
     * @param {string} text - recognized text.
     * @param {{source: string, startedAt?: number, endedAt?: number}} meta - capture facts.
     */
    const append = async (text, meta = {}) => {
      if (isFiller(text)) {
        note(`dropped filler: ${text}`)
        return
      }
      const source = meta.source === 'mic' ? 'mic' : 'system'
      const range = { startedAt: Number(meta.startedAt) || 0, endedAt: Number(meta.endedAt) || 0 }
      const normalized = normalize(text)
      // A repeated sentence arrives when the VAD splits one utterance in two.
      if (state.segments.some(item => item.raw === text && Date.now() - item.at < 15000)) {
        note(`dropped repeat: ${text.slice(0, 40)}`)
        return
      }
      const echo = segment => overlapOf(segment, range) >= ECHO_OVERLAP
        && similarity(normalize(segment.text), normalized) >= ECHO_SIMILARITY
      if (source === 'mic' && state.segments.some(item => item.source === 'system' && echo(item))) {
        note(`dropped mic echo: ${text.slice(0, 40)}`)
        return
      }
      if (source === 'system') {
        const before = state.segments.length
        state.segments = state.segments.filter(item => !(item.source === 'mic' && echo(item)))
        if (state.segments.length !== before) note('dropped earlier mic echo')
      }
      const last = state.segments[state.segments.length - 1]
      if (last !== undefined && last.text === text && Date.now() - last.at < 3000) return
      seq += 1
      const label = source === 'mic' ? '我' : '对方'
      // Only the other side's questions wake the agent; everything else is context.
      let trigger = false
      if (source === 'system') {
        if (!options.onlyQuestions) {
          trigger = true
        } else if (options.judge) {
          const contextLines = state.segments.slice(-3).map(item => item.text)
          const verdict = await judgeQuestion(text, contextLines)
          trigger = verdict === undefined ? isQuestion(text) : verdict
          note(`judge=${String(verdict)} trigger=${String(trigger)} ${text.slice(0, 40)}`)
        } else {
          trigger = isQuestion(text)
        }
      }
      note(`append ${source} trigger=${String(trigger)} ${text.slice(0, 40)}`)
      state.segments = [...state.segments, {
        seq,
        raw: text,
        text: `${label}：${text}`,
        source,
        trigger,
        startedAt: range.startedAt,
        endedAt: range.endedAt,
        at: Date.now(),
      }].slice(-MAX_SEGMENTS)
    }

    const transcribe = async (wavBase64, meta = {}) => {
      if (speech.snapshot().providers.every(item => item.id !== options.providerId)) {
        state.error = `Speech provider is unavailable: ${options.providerId}`
        return
      }
      try {
        const audio = Buffer.from(wavBase64, 'base64')
        const spec = speech.resolve({ audio, providerId: options.providerId, language: options.language })
        const startedAt = Date.now()
        const transcript = await speech.transcribe(spec, requests.signal)
        const text = String(transcript?.text ?? '').trim()
        try {
          appendFileSync(join(here, '.debug.log'),
            `${new Date().toISOString()} transcribe ${meta.source || 'system'} audio=${transcript?.audioSeconds}s infer=${transcript?.inferenceSeconds}s wall=${Date.now() - startedAt}ms chars=${text.length}\n`)
        } catch (_error) {
          // Timing diagnostics are optional.
        }
        const tooShort = (Number(transcript?.audioSeconds) || 0) < 0.6 && text.length <= 3
        if (text !== '' && !(meta.source === 'mic' && tooShort)) await append(text, meta)
      } catch (error) {
        if (!requests.signal.aborted) state.error = error instanceof Error ? error.message : String(error)
      }
    }

    const onLine = (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch (_error) {
        return
      }
      switch (message.type) {
        case 'ready':
          state.phase = 'listening'
          if (message.source === 'mic') state.micDevice = message.device || state.micDevice
          else state.device = message.device || ''
          state.error = ''
          note(`ready ${message.source || 'system'} device=${message.device}`)
          break
        case 'devices':
          state.devices = Array.isArray(message.speakers) ? message.speakers : state.devices
          state.microphones = Array.isArray(message.microphones) ? message.microphones : state.microphones
          break
        case 'device':
          if (message.source === 'mic') state.micDevice = message.device || ''
          else state.device = message.device || ''
          note(`device switched (${message.source || 'system'}) to ${message.device}`)
          break
        case 'level':
          if (message.source === 'mic') state.micLevel = Number(message.level) || 0
          else state.systemLevel = Number(message.level) || 0
          state.level = Math.max(state.level * 0.5, Number(message.level) || 0)
          if (Date.now() - lastLevelNote >= 5000) {
            lastLevelNote = Date.now()
            note(`level system=${state.systemLevel} mic=${state.micLevel} device=${state.device} micDevice=${state.micDevice}`)
          }
          break
        case 'utterance': {
          const wav = String(message.wav || '')
          const meta = { source: message.source, startedAt: message.startedAt, endedAt: message.endedAt }
          note(`utterance seq=${message.seq} source=${meta.source} seconds=${message.seconds}`)
          if (wav !== '') queue = queue.then(() => transcribe(wav, meta))
          break
        }
        case 'error':
          note(`helper error (${message.source || 'system'}): ${message.message}`)
          if (message.source === 'mic') {
            // A microphone problem must not stop the loopback channel.
            state.micDevice = ''
          } else {
            state.phase = 'error'
            state.error = String(message.message || 'capture failed')
          }
          break
        default:
          break
      }
    }

    const onExit = (code) => {
      child = undefined
      state.level = 0
      if (stopped) return
      state.phase = 'error'
      if (state.error === '') state.error = `capture helper exited with code ${code}`
    }

    const stop = () => {
      stopped = true
      state.phase = 'idle'
      state.level = 0
      if (waitTimer !== undefined) {
        clearInterval(waitTimer)
        waitTimer = undefined
      }
      if (child !== undefined) {
        const active = child
        child = undefined
        try {
          active.kill()
        } catch (_error) {
          // The helper already exited.
        }
      }
    }

    const ready = phase => phase === 'ready' || phase === 'standby' || phase === 'waking'

    const spawnHelper = () => {
      state.phase = 'starting'
      state.error = ''
      state.segments = []
      seq = 0
      const args = [
        '-u',
        options.helperPath,
        '--silence',
        String(options.silenceMs / 1000),
        '--max-utterance',
        String(options.maxUtteranceMs / 1000),
      ]
      if (options.device !== '') args.push('--device', options.device)
      if (!options.mic) args.push('--no-mic')
      else if (options.micDevice !== '') args.push('--mic-device', options.micDevice)
      const proc = spawn(options.pythonPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      child = proc
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk) => {
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) if (line.trim() !== '') onLine(line)
      })
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (chunk) => {
        const text = String(chunk).trim()
        if (text !== '') console.warn(`[meeting-ears] ${text}`)
      })
      proc.on('error', (error) => {
        state.phase = 'error'
        state.error = `cannot start ${options.pythonPath}: ${error.message}`
        stopped = true
      })
      proc.on('exit', (code) => onExit(code))
    }

    const start = () => {
      if (!stopped) return
      stopped = false
      state.phase = 'starting'
      state.error = ''
      const phase = prepPhase()
      if (ready(phase)) {
        // Wake the recognizer now instead of paying the cold start on the first
        // sentence the user says.
        try {
          speech.prepare(options.providerId)
        } catch (_error) {
          // A wake failure surfaces on the first transcription instead.
        }
        spawnHelper()
        return
      }
      if (phase === 'unprepared' || phase === 'unknown') {
        try {
          speech.prepare(options.providerId)
        } catch (error) {
          state.error = error instanceof Error ? error.message : String(error)
        }
      }
      waitTimer = setInterval(() => {
        const next = prepPhase()
        if (!ready(next)) return
        clearInterval(waitTimer)
        waitTimer = undefined
        if (!stopped && child === undefined) spawnHelper()
      }, 1500)
    }

    const handle = async (endpoint, payload) => {
      try {
        // Polling happens several times a second; logging it costs synchronous
        // disk I/O in the Host process and buries the useful events.
        if (endpoint !== 'poll') {
          try {
            appendFileSync(join(here, '.debug.log'), `${new Date().toISOString()} ${endpoint} ${JSON.stringify(payload ?? {}).slice(0, 160)}\n`)
          } catch (_error) {
            // Diagnostics must never break the request.
          }
        }
        switch (endpoint) {
          case 'poll': {
            const since = Number(payload?.since)
            const full = describe()
            // A negative cursor is a fresh subscriber: hand it the baseline only,
            // so a remount never replays already-sent sentences.
            const segments = Number.isFinite(since) && since >= 0
              ? full.segments.filter(item => item.seq > since)
              : []
            return { ok: true, value: { ...full, segments } }
          }
          case 'start':
            start()
            return { ok: true, value: describe() }
          case 'stop':
            stop()
            return { ok: true, value: describe() }
          case 'configure': {
            let changed = false
            let audioChanged = false
            const patch = {}
            const nextSilence = Number(payload?.silenceMs)
            if (Number.isFinite(nextSilence) && nextSilence >= 200 && nextSilence <= 10000) {
              options.silenceMs = Math.round(nextSilence)
              patch.silenceMs = options.silenceMs
              changed = true
              audioChanged = true
            }
            if (typeof payload?.device === 'string' && payload.device !== options.device) {
              options.device = payload.device
              patch.device = options.device
              changed = true
              audioChanged = true
            }
            if (typeof payload?.language === 'string' && payload.language !== options.language) {
              options.language = payload.language
              patch.language = options.language
              changed = true
            }
            if (typeof payload?.autoSend === 'boolean' && payload.autoSend !== state.autoSend) {
              state.autoSend = payload.autoSend
              patch.autoSend = payload.autoSend
              changed = true
            }
            if (typeof payload?.mic === 'boolean' && payload.mic !== options.mic) {
              options.mic = payload.mic
              patch.mic = payload.mic
              changed = true
              audioChanged = true
            }
            if (typeof payload?.micDevice === 'string' && payload.micDevice !== options.micDevice) {
              options.micDevice = payload.micDevice
              patch.micDevice = payload.micDevice
              changed = true
              audioChanged = true
            }
            if (typeof payload?.onlyQuestions === 'boolean' && payload.onlyQuestions !== options.onlyQuestions) {
              options.onlyQuestions = payload.onlyQuestions
              patch.onlyQuestions = payload.onlyQuestions
              changed = true
            }
            if (typeof payload?.judge === 'boolean' && payload.judge !== options.judge) {
              options.judge = payload.judge
              patch.judge = payload.judge
              changed = true
            }
            if (typeof payload?.judgeProvider === 'string' && payload.judgeProvider !== options.judgeProvider) {
              options.judgeProvider = payload.judgeProvider
              patch.judgeProvider = payload.judgeProvider
              changed = true
            }
            if (typeof payload?.judgeModel === 'string' && payload.judgeModel !== options.judgeModel) {
              options.judgeModel = payload.judgeModel
              patch.judgeModel = payload.judgeModel
              changed = true
            }
            if (changed) {
              saveState()
              await persist(patch)
            }
            if (audioChanged && !stopped) {
              stop()
              start()
            }
            return { ok: true, value: describe() }
          }
          case 'devices':
            return { ok: true, value: await listDevices() }
          case 'models':
            return { ok: true, value: await listModels() }
          case 'sent':
            note(`sent seq=${Number(payload?.seq) || 0} chars=${Number(payload?.chars) || 0}`)
            return { ok: true, value: null }
          default:
            return { ok: false, error: { code: 'meeting-ears/unknown-endpoint', message: `unknown endpoint ${endpoint}`, details: {} } }
        }
      } catch (error) {
        return {
          ok: false,
          error: { code: 'meeting-ears/failed', message: error instanceof Error ? error.message : String(error), details: {} },
        }
      }
    }

    scope.effect(() => scope.connection.fetch.register({
      path: '/api/meeting-ears',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let envelope
        try {
          envelope = await request.json()
        } catch (_error) {
          envelope = undefined
        }
        const payload = envelope?.payload ?? {}
        const result = await handle(payload.endpoint, payload)
        return Response.json({ type: 'server-response', rpcId: envelope?.rpcId, result })
      },
    }))
    scope.effect(() => () => {
      stop()
      requests.abort(new Error('meeting ears disposed'))
    })
  })
}
