#!/usr/bin/env python3
"""Capture the Windows default output device through WASAPI loopback and emit
speech utterances as 16 kHz mono PCM16 WAV, one JSON line per utterance.

Protocol (stdout, newline-delimited JSON):
  {"type":"ready","device":...,"devices":[...],"captureRate":...,"outRate":16000}
  {"type":"device","device":...,"devices":[...]}          (default output changed)
  {"type":"level","level":0.0..1.0}
  {"type":"utterance","seq":N,"seconds":1.23,"wav":"<base64>"}
  {"type":"error","message":...}

Stderr carries diagnostics only.

The render endpoint must stay active for WASAPI loopback to deliver frames, so a
silent render stream keeps it alive even when nothing else is playing. The helper
follows the Windows default output device: switching speakers takes effect within
about two seconds without restarting the plugin. Pass --device to pin one device.
"""

import argparse
import base64
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


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()

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


def loopback_devices(pa) -> list[str]:
    return [device["name"] for device in pa.get_loopback_device_info_generator()]


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


def pick_loopback(pa, wanted: str | None):
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
            emit({"type": "error", "message": f"keep-alive open failed: {error}"})
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


def open_capture(pa, loopback):
    rate = int(loopback["defaultSampleRate"])
    channels = min(2, max(1, int(loopback["maxInputChannels"])))
    frame_samples = int(rate * FRAME_MS / 1000)
    stream = pa.open(
        format=pyaudio.paFloat32,
        channels=channels,
        rate=rate,
        input=True,
        input_device_index=loopback["index"],
        frames_per_buffer=frame_samples,
    )
    return stream, rate, channels, frame_samples


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default=None, help="substring of the loopback device name")
    parser.add_argument("--silence", type=float, default=1.8, help="seconds of silence that end an utterance")
    parser.add_argument("--min-speech", type=float, default=0.25, help="minimum voiced seconds to emit")
    parser.add_argument("--max-utterance", type=float, default=45.0, help="hard cap on one utterance")
    parser.add_argument("--threshold", type=float, default=0.0, help="fixed RMS threshold (0 = adaptive)")
    parser.add_argument("--list-devices", action="store_true", help="print loopback devices and exit")
    args = parser.parse_args()

    pa = pyaudio.PyAudio()

    if args.list_devices:
        emit({"type": "devices", "devices": loopback_devices(pa)})
        pa.terminate()
        return 0

    try:
        loopback, output = pick_loopback(pa, args.device)
        stream, rate, channels, frame_samples = open_capture(pa, loopback)
    except Exception as error:
        emit({"type": "error", "message": str(error)})
        pa.terminate()
        return 1

    keepalive = KeepAlive(pa, output)
    keepalive.start()
    time.sleep(0.3)

    emit({"type": "ready", "device": loopback["name"], "devices": loopback_devices(pa),
          "captureRate": rate, "outRate": OUT_RATE})

    preroll_frames = int(0.4 * 1000 / FRAME_MS)
    preroll: list[np.ndarray] = []
    utterance: list[np.ndarray] | None = None
    silence_run = 0.0
    speech_run = 0.0
    seq = 0
    noise_floor = 0.002
    last_level_emit = 0.0
    last_device_check = time.monotonic()

    def reset_utterance() -> None:
        nonlocal utterance, silence_run, speech_run, preroll
        utterance = None
        silence_run = 0.0
        speech_run = 0.0
        preroll = []

    def rebind() -> None:
        """Re-open capture on the current default output after a device switch."""
        nonlocal loopback, output, stream, rate, channels, frame_samples, keepalive
        recent, recent_output = default_loopback(pa)
        if recent is None or recent["index"] == loopback["index"]:
            return
        try:
            fresh, fresh_rate, fresh_channels, fresh_frames = open_capture(pa, recent)
        except Exception as error:
            emit({"type": "error", "message": f"cannot switch to {recent['name']}: {error}"})
            return
        try:
            stream.stop_stream()
            stream.close()
        except Exception:
            pass
        keepalive.stop()
        keepalive = KeepAlive(pa, recent_output)
        keepalive.start()
        loopback, output = recent, recent_output
        stream, rate, channels, frame_samples = fresh, fresh_rate, fresh_channels, fresh_frames
        reset_utterance()
        noise_floor = 0.002
        emit({"type": "device", "device": loopback["name"], "devices": loopback_devices(pa)})

    try:
        while True:
            raw = stream.read(frame_samples, exception_on_overflow=False)
            mono = np.frombuffer(raw, dtype=np.float32)
            if channels > 1:
                mono = mono.reshape(-1, channels).mean(axis=1)
            level = float(np.sqrt(np.mean(mono * mono))) if mono.size else 0.0

            adaptive = max(noise_floor * 3.5, 0.0035)
            threshold = max(args.threshold, adaptive) if args.threshold > 0 else adaptive
            voiced = level > threshold

            if utterance is None:
                preroll.append(mono.copy())
                if len(preroll) > preroll_frames:
                    preroll.pop(0)
                noise_floor = min(noise_floor * 0.995 + level * 0.005, level + 0.001) if not voiced else noise_floor
                if voiced:
                    speech_run += FRAME_MS / 1000
                    if speech_run >= 0.12:
                        utterance = list(preroll)
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
                if silence_run >= args.silence or seconds >= args.max_utterance:
                    tail = utterance[: max(1, len(utterance) - int(silence_run * 1000 / FRAME_MS))]
                    data = np.concatenate(tail) if tail else np.zeros(0, dtype=np.float32)
                    voiced_seconds = seconds - silence_run
                    if data.size and voiced_seconds >= args.min_speech:
                        seq += 1
                        wav = to_wav(to_16k(data, rate))
                        emit({"type": "utterance", "seq": seq,
                              "seconds": round(float(data.size) / rate, 2),
                              "wav": base64.b64encode(wav).decode("ascii")})
                    reset_utterance()
                    preroll = [mono.copy()]

            now = time.monotonic()
            if now - last_level_emit >= 0.2:
                last_level_emit = now
                emit({"type": "level", "level": round(min(1.0, level / 0.08), 3)})
            if args.device is None and now - last_device_check >= DEVICE_CHECK_SECONDS:
                last_device_check = now
                rebind()
    except KeyboardInterrupt:
        pass
    finally:
        keepalive.stop()
        try:
            stream.stop_stream()
            stream.close()
        except Exception:
            pass
        pa.terminate()
    return 0


if __name__ == "__main__":
    sys.exit(main())
