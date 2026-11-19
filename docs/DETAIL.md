# Meeting ears

Turn whatever the computer is playing (Tencent Meeting, Feishu calls, a video, a lecture) into text and send each finished sentence to the current conversation.

## What it does

- Records the **default output device** through Windows WASAPI loopback, so it contains other participants and system playback, never your own microphone.
- Segments speech locally: continuous talking stops, 1.8 s of silence, the whole sentence (up to 45 s) goes to recognition.
- Recognizes with DSH's bundled local SenseVoice model (offline, CPU, best for Chinese); audio never leaves the machine.
- When the composer is idle it inserts the sentence and sends it. While the composer is busy it holds the text and offers **Insert** instead.

## Usage

1. Enable the bundle. Recognition uses DSH's speech service, so the official **Voice input** bundle must be enabled too (it provides the local SenseVoice model).
2. A **Meeting ears** pill appears under the composer. The first click downloads SenseVoice when missing (INT8, about 240 MB, from Hugging Face or HF-Mirror) and shows progress on the same row; capture starts only once it is ready.
3. Play a talking video: after a sentence and a ~2 s pause the text is placed in the composer and sent.
4. The row shows a live level meter, the latest sentence, and how many are pending.

## Requirements and limits

- The capture helper is Python; the machine needs Python 3.10+ with `pyaudiowpatch` and `numpy` (`python -m pip install pyaudiowpatch numpy`). Missing dependencies appear as the row's error.
- Only the default output device is captured; set `device` to a substring of another loopback device. Switch the Windows default output before listening when devices rotate.
- WASAPI loopback stalls when nothing renders, so the helper plays a silent keep-alive stream; that stream is inaudible.
- Recognition is whole-utterance, not word-by-word streaming: text lands about a second after the sentence ends.
- Your own microphone is not captured, but an app that plays your voice back will be transcribed.
- The pill lives in the composer dock, below the input, so it coexists with the official voice-input button; the plugin stays inactive while the official Voice input bundle is disabled.
- No speaker diarization or timestamps; the panel keeps the last 40 sentences.

## Config (`config` in `cordis.patch.yml`)

| Field | Default | Meaning |
| --- | --- | --- |
| `pythonPath` | `python` | Python executable; use an absolute path when the GUI cannot find it |
| `silenceMs` | `1800` | Silence that ends a sentence |
| `maxUtteranceMs` | `45000` | Longest single sentence before a forced cut |
| `language` | `zh` | `zh`, `en`, `yue`, `ja`, `ko`, `auto` |
| `autoSend` | `true` | `false` only transcribes and waits for **Insert** |
| `device` | default output | Substring of the loopback device name |

Model files are managed by the speech service; reinstalling or disabling the plugin does not download them again.
