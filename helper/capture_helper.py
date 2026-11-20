#!/usr/bin/env python3
"""Capture system output (WASAPI loopback) and optionally the default microphone,
then emit speech utterances as 16 kHz mono PCM16 WAV, one JSON line each.

Protocol (stdout, newline-delimited JSON):
  {"type":"devices","speakers":[...],"microphones":[...]}
  {"type":"ready","source":"system","device":...,"captureRate":...}
  {"type":"ready","source":"mic","device":...,"captureRate":...}
  {"type":"device","source":...,"device":...}
  {"type":"level","source":"system"|"mic","level":0.0..1.0}
  {"type":"utterance","seq":N,"source":...,"seconds":1.23,
   "startedAt":<ms on the process monotonic clock>,"endedAt":<ms>,
   "wav":"<base64>"}
  {"type":"error","source":...,"message":...}

Stderr carries diagnostics only.

The render endpoint must stay active for WASAPI loopback to deliver frames, so a
silent render stream keeps it alive even when nothing else is playing. Output and
microphone devices are followed (or pinned with --device / --mic-device); both
channels share one monotonic clock so the Host can compare their time ranges.
"""

import argparse
import base64
import collections
import io
import json
import sys
import threading
import time
import wave

import numpy as np
import pyaudiowpatch as pyaudio

OUT_RATE = 16000
FRAME_MS = 20
DEVICE_CHECK_SECONDS = 2.0

# The Host reads stdout as UTF-8; Windows would otherwise pick the ANSI codepage
# for a piped stream and mangle non-ASCII device names.
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

_emit_lock = threading.Lock()
_seq_lock = threading.Lock()
_seq = 0


def emit(payload: dict) -> None:
    with _emit_lock:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def next_seq() -> int:
    global _seq
    with _seq_lock:
        _seq += 1
        return _seq


def design_lowpass(factor: int, taps: int = 63) -> np.ndarray:
    n = np.arange(taps) - (taps - 1) / 2.0
    cutoff = 0.5 / factor
    h = np.sinc(2 * cutoff * n) * np.hamming(taps)
    return (h / h.sum()).astype(np.float32)


def to_16k(mono: np.ndarray, rate: int) -> np.ndarray:
    """Low-pass, decimate, then resample to exactly 16 kHz."""
    if rate == OUT_RATE or mono.size == 0:
        return mono
    factor = max(1, round(rate / OUT_RATE))
    filtered = np.convolve(mono, design_lowpass(factor), mode="same")
    decimated = filtered[::factor]
    decimated_rate = rate / factor
    target = int(round(decimated.size * OUT_RATE / decimated_rate))
    if target <= 1:
        return decimated.astype(np.float32)
    source_x = np.linspace(0.0, 1.0, decimated.size, endpoint=False)
    target_x = np.linspace(0.0, 1.0, target, endpoint=False)
    return np.interp(target_x, source_x, decimated).astype(np.float32)


def to_wav(mono_16k: np.ndarray) -> bytes:
    pcm = np.clip(mono_16k, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype(np.int16)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(OUT_RATE)
        handle.writeframes(pcm.tobytes())
    return buffer.getvalue()


# ---------------------------------------------------------------- device lookup

def wasapi_host_index(pa) -> int:
    return int(pa.get_host_api_info_by_type(pyaudio.paWASAPI)["index"])


def wasapi_inputs(pa) -> list:
    """WASAPI capture endpoints (real microphones, never loopback mirrors)."""
    host = wasapi_host_index(pa)
    result = []
    for index in range(pa.get_device_count()):
        info = pa.get_device_info_by_index(index)
        if int(info.get("maxInputChannels", 0)) <= 0:
            continue
        if int(info.get("hostApi", -1)) != host:
            continue
        if "[Loopback]" in info["name"]:
            continue
        result.append(info)
    return result


def loopback_devices(pa) -> list[str]:
    return [device["name"] for device in pa.get_loopback_device_info_generator()]


def microphone_devices(pa) -> list[str]:
    return [info["name"] for info in wasapi_inputs(pa)]


def default_output(pa):
    wasapi = pa.get_host_api_info_by_type(pyaudio.paWASAPI)
    return pa.get_device_info_by_index(wasapi["defaultOutputDevice"])


def default_loopback(pa):
    """Return the loopback device that currently mirrors the default output."""
    output = default_output(pa)
    for device in pa.get_loopback_device_info_generator():
        if device["name"].startswith(output["name"]):
            return device, output
    return None, output


def mic_candidates(pa, wanted: str | None) -> list:
    """Ordered microphone candidates: pinned match, else the system default first."""
    devices = wasapi_inputs(pa)
    if wanted:
        return [d for d in devices if wanted.lower() in d["name"].lower()]
    result = []
    try:
        name = pa.get_default_input_device_info()["name"]
        result = [d for d in devices if d["name"] == name]
    except Exception:
        result = []
    for device in devices:
        if all(device["index"] != kept["index"] for kept in result):
            result.append(device)
    return result


def pick_system(pa, wanted: str | None):
    if wanted:
        matches = [d for d in pa.get_loopback_device_info_generator() if wanted.lower() in d["name"].lower()]
        if not matches:
            raise RuntimeError(f"no loopback device matches {wanted!r}")
        return matches[0], default_output(pa)
    loopback, output = default_loopback(pa)
    if loopback is None:
        raise RuntimeError(f"no loopback device for default output {output['name']!r}")
    return loopback, output


class KeepAlive:
    """Hold the render endpoint open with silence so loopback keeps delivering frames."""

    def __init__(self, pa, device):
        self.pa = pa
        self.device = device
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        try:
            rate = int(self.device["defaultSampleRate"])
            channels = min(2, max(1, int(self.device["maxOutputChannels"])))
            stream = self.pa.open(
                format=pyaudio.paFloat32,
                channels=channels,
                rate=rate,
                output=True,
                output_device_index=self.device["index"],
                frames_per_buffer=1024,
            )
        except Exception as error:  # pragma: no cover - device dependent
            emit({"type": "error", "source": "system", "message": f"keep-alive open failed: {error}"})
            return
        silence = np.zeros((1024, channels), dtype=np.float32).tobytes()
        try:
            while not self.stop_event.is_set():
                stream.write(silence)
        finally:
            try:
                stream.stop_stream()
                stream.close()
            except Exception:
                pass

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()


def open_capture(pa, device):
    rate = int(device["defaultSampleRate"])
    channels = min(2, max(1, int(device["maxInputChannels"])))
    frame_samples = int(rate * FRAME_MS / 1000)
    stream = pa.open(
        format=pyaudio.paFloat32,
        channels=channels,
        rate=rate,
        input=True,
        input_device_index=device["index"],
        frames_per_buffer=frame_samples,
    )
    return stream, rate, channels, frame_samples


class Channel:
    """One capture channel (system loopback or microphone) with its own VAD."""

    def __init__(self, pa, source, options, wanted=None):
        self.pa = pa
        self.source = source
        self.options = options
        self.wanted = wanted
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.stream = None
        self.device = None
        self.keepalive = None

    def _open_system(self):
        device, output = pick_system(self.pa, self.wanted)
        stream, rate, channels, frame_samples = open_capture(self.pa, device)
        self.stream, self.device = stream, device
        if output is not None:
            self.keepalive = KeepAlive(self.pa, output)
            self.keepalive.start()
        return stream, device, rate, channels, frame_samples

    def _open_mic(self):
        candidates = mic_candidates(self.pa, self.wanted)
        if not candidates:
            raise RuntimeError("no microphone device")
        last = None
        for device in candidates:
            try:
                stream, rate, channels, frame_samples = open_capture(self.pa, device)
            except Exception as error:
                last = error
                continue
            self.stream, self.device = stream, device
            return stream, device, rate, channels, frame_samples
        raise RuntimeError(f"no openable microphone ({last})")

    def _open(self):
        if self.source == "system":
            stream, device, rate, channels, frame_samples = self._open_system()
        else:
            stream, device, rate, channels, frame_samples = self._open_mic()
        emit({"type": "ready", "source": self.source, "device": device["name"],
              "captureRate": rate, "outRate": OUT_RATE})
        return stream, rate, channels, frame_samples

    def _close(self):
        if self.keepalive is not None:
            self.keepalive.stop()
            self.keepalive = None
        if self.stream is not None:
            try:
                self.stream.stop_stream()
                self.stream.close()
            except Exception:
                pass
            self.stream = None

    def _current_default(self):
        if self.source == "system":
            device, _output = default_loopback(self.pa)
            return device
        candidates = mic_candidates(self.pa, None)
        return candidates[0] if candidates else None

    def _rebind(self):
        if self.wanted is not None:
            return None
        try:
            recent = self._current_default()
        except Exception:
            return None
        if recent is None or (self.device is not None and recent["index"] == self.device["index"]):
            return None
        try:
            self._close()
            if self.source == "system":
                stream, device, rate, channels, frame_samples = self._open_system()
            else:
                stream, device, rate, channels, frame_samples = self._open_mic()
        except Exception as error:
            emit({"type": "error", "source": self.source, "message": f"cannot switch device: {error}"})
            return None
        emit({"type": "device", "source": self.source, "device": device["name"]})
        return stream, rate, channels, frame_samples

    # -- capture loop --------------------------------------------------------
    def _run(self) -> None:
        options = self.options
        try:
            stream, rate, channels, frame_samples = self._open()
        except Exception as error:
            emit({"type": "error", "source": self.source, "message": str(error)})
            return

        preroll_frames = int(0.4 * 1000 / FRAME_MS)
        preroll: list[np.ndarray] = []
        utterance: list[np.ndarray] | None = None
        utterance_start = 0.0
        silence_run = 0.0
        speech_run = 0.0
        levels: collections.deque = collections.deque(maxlen=75)
        last_level_emit = 0.0
        last_device_check = time.monotonic()

        def reset() -> None:
            nonlocal utterance, silence_run, speech_run, preroll, utterance_start
            utterance = None
            silence_run = 0.0
            speech_run = 0.0
            preroll = []
            utterance_start = 0.0

        # A webcam or headset microphone has a much higher noise floor than a
        # digital loopback, so it needs a longer onset before it counts as speech.
        min_speech = 0.35 if self.source == "mic" else options.min_speech

        while not self.stop_event.is_set():
            try:
                raw = stream.read(frame_samples, exception_on_overflow=False)
            except Exception as error:
                emit({"type": "error", "source": self.source, "message": f"read failed: {error}"})
                reset()
                time.sleep(0.5)
                try:
                    self._close()
                    stream, rate, channels, frame_samples = self._open()
                except Exception as again:
                    emit({"type": "error", "source": self.source, "message": str(again)})
                    return
                continue

            mono = np.frombuffer(raw, dtype=np.float32)
            if channels > 1:
                mono = mono.reshape(-1, channels).mean(axis=1)
            if mono.size:
                mono = mono - float(mono.mean())
            level = float(np.sqrt(np.mean(mono * mono))) if mono.size else 0.0
            levels.append(level)

            # Rolling 20th percentile instead of a one-way estimator: a hot or
            # humming microphone has a high, steady floor that a "only adapt while
            # silent" rule never learns, which pins the VAD on forever.
            # The cap keeps a noisy microphone from demanding unreachable volume.
            floor = float(np.percentile(levels, 20)) if len(levels) >= 10 else 0.002
            threshold = min(max(floor * 1.5, 0.004), 0.03)
            if options.threshold > 0:
                threshold = options.threshold
            voiced = level > threshold
            now = time.monotonic()

            if utterance is None:
                preroll.append(mono.copy())
                if len(preroll) > preroll_frames:
                    preroll.pop(0)
                if voiced:
                    speech_run += FRAME_MS / 1000
                    if speech_run >= 0.12:
                        utterance = list(preroll)
                        utterance_start = now - len(preroll) * FRAME_MS / 1000
                        preroll = []
                        silence_run = 0.0
                else:
                    speech_run = 0.0
            else:
                utterance.append(mono.copy())
                if voiced:
                    silence_run = 0.0
                else:
                    silence_run += FRAME_MS / 1000
                seconds = len(utterance) * FRAME_MS / 1000
                if silence_run >= options.silence or seconds >= options.max_utterance:
                    drop = int(silence_run * 1000 / FRAME_MS)
                    tail = utterance[: max(1, len(utterance) - drop)]
                    data = np.concatenate(tail) if tail else np.zeros(0, dtype=np.float32)
                    voiced_seconds = seconds - silence_run
                    if data.size and voiced_seconds >= min_speech:
                        emit({"type": "utterance", "seq": next_seq(), "source": self.source,
                              "seconds": round(float(data.size) / rate, 2),
                              "startedAt": int(utterance_start * 1000),
                              "endedAt": int((utterance_start + data.size / rate) * 1000),
                              "wav": base64.b64encode(to_wav(to_16k(data, rate))).decode("ascii")})
                    reset()
                    preroll = [mono.copy()]

            if now - last_level_emit >= 0.2:
                last_level_emit = now
                emit({"type": "level", "source": self.source, "level": round(min(1.0, level / 0.08), 3)})

            if options.follow and now - last_device_check >= DEVICE_CHECK_SECONDS:
                last_device_check = now
                bound = self._rebind()
                if bound is not None:
                    stream, rate, channels, frame_samples = bound
                    reset()

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self._close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default=None, help="substring of the loopback device name")
    parser.add_argument("--mic-device", default=None, help="substring of the microphone name")
    parser.add_argument("--no-mic", action="store_true", help="capture system output only")
    parser.add_argument("--silence", type=float, default=1.0, help="seconds of silence that end an utterance")
    parser.add_argument("--min-speech", type=float, default=0.25, help="minimum voiced seconds to emit")
    parser.add_argument("--max-utterance", type=float, default=45.0, help="hard cap on one utterance")
    parser.add_argument("--threshold", type=float, default=0.0, help="fixed RMS threshold (0 = adaptive)")
    parser.add_argument("--list-devices", action="store_true", help="print devices and exit")
    args = parser.parse_args()

    pa = pyaudio.PyAudio()

    if args.list_devices:
        emit({"type": "devices", "speakers": loopback_devices(pa), "microphones": microphone_devices(pa)})
        pa.terminate()
        return 0

    options = argparse.Namespace(
        silence=args.silence,
        min_speech=args.min_speech,
        max_utterance=args.max_utterance,
        threshold=args.threshold,
        follow=True,
    )

    channels = [Channel(pa, "system", options, args.device)]
    if not args.no_mic:
        channels.append(Channel(pa, "mic", options, args.mic_device))

    emit({"type": "devices", "speakers": loopback_devices(pa), "microphones": microphone_devices(pa)})
    for channel in channels:
        channel.start()

    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        for channel in channels:
            channel.stop()
        pa.terminate()
    return 0


if __name__ == "__main__":
    sys.exit(main())
