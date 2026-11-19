/** Host half: capture system audio, transcribe it locally, expose the transcript to the composer UI. */
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'meeting-ears'

const here = dirname(fileURLToPath(import.meta.url))
const HELPER = join(here, 'helper', 'capture_helper.py')
const MAX_SEGMENTS = 40

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
  }

  const state = {
    phase: 'idle',
    device: '',
    devices: [],
    error: '',
    level: 0,
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
        error: state.error,
        level: state.level,
        prep,
        silenceMs: options.silenceMs,
        devicePin: options.device,
        latest: state.segments.length === 0 ? 0 : state.segments[state.segments.length - 1].seq,
        autoSend: state.autoSend,
        segments: state.segments,
      }
    }

    const append = (text) => {
      const last = state.segments[state.segments.length - 1]
      if (last !== undefined && last.text === text && Date.now() - last.at < 3000) return
      seq += 1
      state.segments = [...state.segments, { seq, text, at: Date.now() }].slice(-MAX_SEGMENTS)
    }

    const transcribe = async (wavBase64) => {
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
            `${new Date().toISOString()} transcribe audio=${transcript?.audioSeconds}s infer=${transcript?.inferenceSeconds}s wall=${Date.now() - startedAt}ms chars=${text.length}\n`)
        } catch (_error) {
          // Timing diagnostics are optional.
        }
        if (text !== '') append(text)
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
          state.device = message.device || ''
          state.devices = Array.isArray(message.devices) ? message.devices : state.devices
          state.error = ''
          note(`ready device=${state.device}`)
          break
        case 'device':
          state.device = message.device || ''
          state.devices = Array.isArray(message.devices) ? message.devices : state.devices
          note(`device switched to ${state.device}`)
          break
        case 'level':
          state.level = Number(message.level) || 0
          if (Date.now() - lastLevelNote >= 5000) {
            lastLevelNote = Date.now()
            note(`level=${state.level} device=${state.device}`)
          }
          break
        case 'utterance': {
          const wav = String(message.wav || '')
          note(`utterance seq=${message.seq} seconds=${message.seconds}`)
          if (wav !== '') queue = queue.then(() => transcribe(wav))
          break
        }
        case 'error':
          state.phase = 'error'
          state.error = String(message.message || 'capture failed')
          note(`helper error: ${state.error}`)
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
        try {
          appendFileSync(join(here, '.debug.log'), `${new Date().toISOString()} ${endpoint} ${JSON.stringify(payload ?? {}).slice(0, 160)}\n`)
        } catch (_error) {
          // Diagnostics must never break the request.
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
            const nextSilence = Number(payload?.silenceMs)
            if (Number.isFinite(nextSilence) && nextSilence >= 200 && nextSilence <= 10000) {
              options.silenceMs = Math.round(nextSilence)
              changed = true
            }
            if (typeof payload?.device === 'string') {
              options.device = payload.device
              changed = true
            }
            if (changed && !stopped) {
              stop()
              start()
            }
            return { ok: true, value: describe() }
          }
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
