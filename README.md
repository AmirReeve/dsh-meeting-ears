# 会议耳朵 · Meeting ears

> 一个 DeepSeek Harness 插件：把你电脑正在播放的声音（腾讯会议、飞书会议、网课、视频）转成文字，
> 静音后整句自动填进对话框并发送。

只录**系统输出**，不碰麦克风——所以只会听到“别人说的话”。识别在本机完成（SenseVoice ONNX），音频不出本机。

## 它怎么工作

```
系统输出（WASAPI loopback）──VAD──┐
                                ├─ 各自断句 → SenseVoice 识别 → 对方：/我：
默认麦克风（可选）──────────VAD──┘
       └─ 扬声器回声：时间重叠 + 文本相似的麦克风那句会被丢掉
```

- 采集跟随**系统默认输出设备**，也可以在界面里钉死某个 loopback 端点；
- 无音频输出时 WASAPI loopback 会停摆，helper 会持续播一路静音流保活（听不见）；
- 设备是 44.1 kHz 也没关系，helper 会先低通再重采样到精确 16 kHz。

## 环境要求

- Windows（WASAPI loopback）与 DeepSeek Harness 0.2.x
- Python 3.10+，并安装依赖：

```bash
python -m pip install pyaudiowpatch numpy
```

- 启用 DSH 自带的 **语音输入 / Voice input** 插件（提供 `speechToText` 服务与 SenseVoice 模型）。
  本插件不重复安装模型服务，禁用语音输入插件时本插件不会激活。

## 安装

```bash
git clone https://github.com/AmirReeve/dsh-meeting-ears.git
cd dsh-meeting-ears
```

然后在 DSH 里安装这个目录：

```bash
dsh plugin add "$(pwd)"
```

或打开 **插件 → 添加插件**，选择本目录。

首次点「开始」时若模型未下载，会先拉取 SenseVoice（INT8，约 240 MB，走 Hugging Face 或 HF-Mirror），
进度直接显示在同一行；下载完成后自动开始采集。

## 使用

1. 输入框工具行（麦克风旁边）出现一只「耳朵」按钮，点它开始监听；
2. 监听期间输入框下方只有一行：停止、音量条、最近一句、待发送条数——不再堆下拉框；
3. 静音窗口（毫秒）、采集设备、识别语言、自动发送开关，都在**插件详情页的「监听设置」**里改，保存后写进 profile，重启保留；
4. 对方说完、静音超过设定时间，整句会填进输入框并发送；你自己说的 `我：` 句不会单独发送，
   而是作为上文缓存（2 分钟内、最多 6 条），随下一句 `对方：` 一起发出。输入框正忙时先攒着，行内显示「插入 · 待发送 N 条」。

## 配置

`cordis.patch.yml` 里这一行的 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `pythonPath` | `python` | Python 可执行文件；GUI 环境找不到时填绝对路径 |
| `silenceMs` | `1000` | 静音多久算一句结束（毫秒） |
| `maxUtteranceMs` | `45000` | 单句最长时长，防止一口气说不停 |
| `language` | `zh` | `zh` / `en` / `yue` / `ja` / `ko` / `auto` |
| `autoSend` | `true` | 关掉后逐句追加到输入框、不自动发送 |
| `mic` | `true` | 同时采集麦克风（你的声音，标成“我”） |
| `micDevice` | 默认麦克风 | 麦克风名的一部分，钉死采集设备 |
| `onlyQuestions` | `true` | 只有对方的问题触发发送，陈述句只作上下文 |
| `judge` | `false` | 用模型判断“是不是问题”（比关键词准，每句多一次小调用） |
| `judgeProvider` / `judgeModel` | 空 | 判定用的 provider 与模型 id |
| `device` | 跟随默认 | loopback 设备名的一部分，钉死采集设备 |

## 调试

运行日志写在插件目录的 `.debug.log`：

```
ready device=扬声器 (EDIFIER M230) [Loopback]
level=0.02 device=...
utterance seq=1 seconds=2.84
transcribe audio=2.84s infer=0.11s wall=113ms chars=11
sent seq=1 chars=11
```

`level` 每 5 秒一行——电平一直是 0 说明没听到声音（选错设备），有电平却不出字才是阈值问题。

## 已知限制

- 只支持 Windows（WASAPI loopback）；
- 是“整句离线识别”，不是逐字流式字幕，一句话结束后约 1 秒出字；
- 会议软件若自己钉死了输出设备，切 Windows 默认输出不会改变它播到哪，需要在会议设置里也切；
- 尚无说话人区分和时间戳；
- 需要本机 Python 环境（helper 是 Python 脚本）。

## License

MIT
