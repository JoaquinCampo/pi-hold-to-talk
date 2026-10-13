# pi-hold-to-talk

Hold Space to dictate into [Pi](https://pi.dev). Speech recognition runs on your Mac. Words appear as you speak, and the full transcript is inserted at the cursor when you let go. If you choose a model for it, that model tidies the transcript first.

```
 ● 0:07 ▅▆▅▇▆▄▆▆  release Space to insert · Esc to cancel
   …look at the header and make it take less vertical space. Also check the
──────────────────────────────────────────────────────────────────────────────
  Please
```

- **On device.** Audio never leaves your machine. Two models run on the Apple Neural Engine through [FluidAudio](https://github.com/FluidInference/FluidAudio):
  - **Nemotron 3.5 Streaming** for the live preview;
  - **Parakeet Ultra** for the final text.
- **Fast.** The final pass on 10 seconds of speech takes about 0.1 s, so text lands about half a second after you let go.
- **Multilingual.** Covers 25 European languages, detected automatically or pinned in the settings.
- **Optional polish.** Any model available in Pi can remove filler words, apply self-corrections ("the footer, no wait, the header") and spell your project vocabulary right. Only this step sends text anywhere.

## Requirements

- A Mac with Apple Silicon, running macOS 15 or later
- Pi 1.1 or later
- About 1.2 GB of disk for the models, downloaded on first use

## Install

```bash
pi install npm:pi-hold-to-talk
```

Start Pi. The first session downloads the models, which takes a minute or two on a fast connection; later starts take under a second.

The first time you dictate, macOS asks whether your terminal may use the microphone. If you said no earlier, turn it on under System Settings › Privacy & Security › Microphone, then restart the terminal.

## Use

| Action | Result |
| --- | --- |
| Hold Space | Start listening after about half a second. |
| Release Space | Insert the transcript at the cursor. |
| Esc while holding | Discard the recording. |
| Any other key while holding | Finish, and type that key. |

Tapping Space types spaces as usual. A hold is recognised by the keyboard's auto-repeat, so the spaces typed while the hold is being detected are removed again. Terminals that support the kitty keyboard protocol report the release exactly; others are taken as released when the repeats stop.

Dictation only starts when the prompt editor has focus. Holding Space in a picker, dialog or overlay does what it normally does.

| Command | |
| --- | --- |
| `/hold-to-talk on` / `off` | Turn dictation on or off for this Pi process. |
| `/hold-to-talk status` | Show the helper state, settings and binary in use. |
| `/hold-to-talk setup` | Build the helper from source (needs the Xcode command line tools). |

## Settings

Create `~/.pi/agent/hold-to-talk.json`. Every key is optional:

```json
{
  "language": "auto",
  "polishModel": "openai-codex/gpt-5.6-luna",
  "vocabulary": ["FluidAudio", "Nemotron", "pi-subagents"]
}
```

| Key | Default | |
| --- | --- | --- |
| `enabled` | `true` | Dictate when holding Space. |
| `language` | `"auto"` | A language code (`"en"`, `"es"`, `"pt-BR"`, …) sharpens recognition when you always speak one language. |
| `livePreview` | `true` | Show text while speaking. Turning it off skips loading the streaming model. |
| `previewChunkMs` | `560` | Preview granularity: `560`, `1120`, `2240` or `4480`. Smaller updates more often. |
| `polishModel` | `null` | `"provider/model-id"` of the model that tidies transcripts. A small, fast model works best. `null` inserts the raw transcript. |
| `polishTimeoutMs` | `4000` | Insert the raw transcript if polishing takes longer. |
| `vocabulary` | `[]` | Names to spell exactly. Used by the polish step. |
| `maxSeconds` | `300` | Stop listening after this long. |
| `helperPath` | `null` | Use a different helper binary. |

Changes apply when Pi starts.

## How it works

The extension starts a small native helper, `pi-hold-to-talk-helper`, once per Pi process and talks to it over JSON lines on stdin and stdout:

- The helper keeps both models loaded, using about 60 MB of memory.
- It opens the microphone only between `start` and `stop`.
- While you speak, it streams audio through Nemotron and sends `partial` events.
- When you release, it runs Parakeet Ultra over the whole recording and sends a `final` event.

The protocol is defined in [`src/protocol.ts`](src/protocol.ts) and [`helper/Sources/HoldToTalkHelper/Protocol.swift`](helper/Sources/HoldToTalkHelper/Protocol.swift).

The helper also works on its own:

```bash
pi-hold-to-talk-helper transcribe recording.wav   # print a transcript
pi-hold-to-talk-helper serve --input speech.wav   # replay a file instead of the microphone
pi-hold-to-talk-helper --help
```

## Troubleshooting

- **Nothing happens when holding Space.** Run `/hold-to-talk status`. If the helper is still loading, the widget shows progress while you hold.
  - If your key repeat is set very slow in System Settings › Keyboard, auto-repeat may be too slow to recognise; a faster repeat rate helps.
  - To see exactly what your terminal sends, start Pi with `PI_HOLD_TO_TALK_DEBUG=1`. It records raw key input to `$TMPDIR/pi-hold-to-talk-input.log`.
- **"The speech helper is not installed".** The package ships a prebuilt helper for Apple Silicon. If it is missing or will not run, `/hold-to-talk setup` builds it from source.
- **Each Pi window loads its own helper.** Every helper holds the models in memory and on the Neural Engine. Close sessions you are not using if memory is tight.

## Development

```bash
npm install
npm run check                 # typecheck and unit tests
scripts/build-helper.sh       # build the helper into bin/
pi -e ./src/index.ts          # try the extension without installing it
```

The helper is a Swift package in `helper/`. FluidAudio is pinned to an exact revision in `helper/Package.swift`.

## Credits and licenses

- This package: MIT.
- [FluidAudio](https://github.com/FluidInference/FluidAudio): Apache 2.0.
- Parakeet Ultra ([CoreML conversion](https://huggingface.co/FluidInference/parakeet-ultra-coreml)): CC BY 4.0.
- Nemotron 3.5 ASR Streaming ([CoreML conversion](https://huggingface.co/FluidInference/Nemotron-3.5-ASR-Streaming-Multilingual-0.6b-CoreML)): OpenMDW 1.1.

The models are downloaded from Hugging Face on first use and are not part of this package.
