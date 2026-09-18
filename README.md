<div align="center">

# ⏩ Silence Skipper

**Automatically speeds through silent (and optionally music-only) parts of any video — YouTube, Instagram, anywhere — and snaps back to normal speed the instant speech resumes.**

[![Manifest](https://img.shields.io/badge/Manifest-V3-blue?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#-license)
[![Status](https://img.shields.io/badge/status-active--development-brightgreen)]()
[![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Chromium-lightgrey?logo=googlechrome)]()

[Features](#-features) • [How it works](#-how-it-works) • [Install](#-installation) • [Configure](#-configuration) • [Roadmap](#-roadmap) • [Contributing](#-contributing)

</div>

---

## 📖 Overview

Ever wish your videos would just... get to the point? **Silence Skipper** watches the audio of whatever video you're playing in real time and temporarily speeds up playback during dead air — then drops back to normal the moment someone starts talking again. No re-encoding, no pre-processing, works on live streams, works on any site with a `<video>` tag.

<div align="center">
<img src="https://via.placeholder.com/720x405.png?text=Demo+GIF+goes+here" alt="Demo GIF placeholder" width="600"/>
<br/>
<sub>👆 Replace this with a real demo GIF/screen recording before publishing</sub>
</div>

---

## ✨ Features

| | |
|---|---|
| 🔇 **Silence skipping** | Detects true silence and ramps playback speed up until sound returns |
| 🎵 **Music-only skipping** | ML-powered: uses [Silero VAD](https://github.com/snakers4/silero-vad) running fully on-device to detect stretches of music/ambience with no speech, and speeds through those too |
| 🎚️ **Fully tunable** | Silence threshold, minimum pause duration, and speed are all adjustable per your taste |
| 🎙️ **Pitch preservation** | Keeps voices sounding natural even at high playback speeds |
| 🏷️ **On-screen indicator** | A small badge shows when and why it's currently speeding up |
| 🌐 **Works everywhere** | Any site using a standard `<video>` element — YouTube, Instagram, lecture platforms, etc. |
| ⚡ **Zero setup** | No accounts, no servers, no data collection — everything runs locally in your browser |

<details>
<summary><b>🤔 Why not just use YouTube's "skip silence" feature?</b></summary>
<br/>

YouTube's built-in speed-up feature is YouTube-only and fairly opaque about how it decides what counts as silence. Silence Skipper works on *any* site, is fully open source, and lets you tune exactly how aggressive it is — including the experimental music-only detection that YouTube doesn't offer at all.
</details>

---

## ⚙️ How it works

```
┌─────────────┐     ┌──────────────────┐     ┌───────────────────┐
│  <video> tag │ --> │  Web Audio API    │ --> │  Real-time volume  │
│  on the page │     │  AnalyserNode     │     │  (dB) check         │
└─────────────┘     └──────────────────┘     └─────────┬──────────┘
                                                          │
                              ┌───────────────────────────┴───────────────┐
                              ▼                                           ▼
                        🔇 Below threshold                         🔊 Audible
                       → ramp to maxSpeed                                │
                                                                          ▼
                                                     ┌────────────────────────────┐
                                                     │ ScriptProcessorNode taps    │
                                                     │ raw PCM → downsample 16kHz  │
                                                     │ → 512-sample frames         │
                                                     └─────────────┬──────────────┘
                                                                   │  chrome.runtime message
                                                                   ▼
                                              ┌────────────────────────────────────┐
                                              │ Offscreen document (hidden page)    │
                                              │ Silero VAD via ONNX Runtime Web     │
                                              │ → speech probability per frame      │
                                              └─────────────────┬────────────────────┘
                                                                 │
                                              ┌──────────────────┴──────────────────┐
                                              ▼                                     ▼
                                     🎵 prob < threshold                  🗣️ prob ≥ threshold
                                    → ramp to musicSpeed                  → ramp to 1x
```

---

## 📥 Installation

### Option A — Load unpacked (for now)

1. Clone or download this repo.
   ```bash
   git clone https://github.com/<your-username>/silence-skipper.git
   ```
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the cloned folder.
5. Play any video — the extension activates automatically.

### Option B — Chrome Web Store

> 🚧 Not yet published. This section will be updated with a direct install link once it's live.

---

## 🎛️ Configuration

Click the extension icon to open the settings popup.

| Setting | Default | Description |
|---|---|---|
| Silence threshold | `-45 dB` | Volume below which audio counts as silent |
| Min. pause before skipping | `350 ms` | How long silence must last before speeding up |
| Speed during silence | `4x` | Playback rate while silent |
| Skip music-only parts | `Off` | Enables ML-based speech-vs-music detection (Silero VAD) |
| Speed during music-only | `2x` | Playback rate during detected music-with-no-speech |
| Min. duration before skipping (music) | `600 ms` | How long a music-only stretch must last before speeding up |
| Speech sensitivity | `0.5` | Silero VAD probability threshold — lower = more readily calls audio "speech" |
| Preserve voice pitch | `On` | Keeps pitch natural at high speeds instead of "chipmunk" audio |
| Show on-screen speed badge | `On` | Small indicator showing current mode/speed |

> 💡 Reload the video's tab after changing settings so the content script picks up new values.

---

## 🧠 How music-vs-speech detection works (v2)

Earlier versions guessed speech vs. music from raw frequency-band energy and its variability — a rough heuristic. **v2 replaces that with an actual voice-activity-detection model: [Silero VAD](https://github.com/snakers4/silero-vad)**, running fully on-device via **ONNX Runtime Web**.

Because MV3 service workers can't run WebAssembly the way this model needs, the model lives in a hidden **offscreen document** (`offscreen.html`/`offscreen.js`) — a Chrome-extension-only page with DOM access but no visible UI. The pipeline:

1. The content script taps the video's audio with a second `ScriptProcessorNode`, downsamples it from the browser's native sample rate to the 16kHz the model expects, and slices it into 512-sample (32ms) frames.
2. Each frame is sent via `chrome.runtime.sendMessage` to the offscreen document.
3. The offscreen document runs the frame through Silero VAD (maintaining the model's recurrent state per video) and returns a speech probability.
4. The content script compares that probability against your "Speech sensitivity" setting to decide whether to treat the current audio as speech or music.

No audio ever leaves the browser — inference is 100% local.

---

## 🗺️ Roadmap

- [x] Replace the frequency-heuristic music/speech detector with a real ML model (Silero VAD via ONNX Runtime Web)
- [ ] Migrate from the deprecated `ScriptProcessorNode` to an `AudioWorklet` for audio capture
- [ ] Per-site custom presets (e.g. different defaults for YouTube vs. lecture platforms)
- [ ] Skip visual indicator styling options
- [ ] Keyboard shortcut to toggle on/off without opening the popup
- [ ] Firefox support (WebExtensions port)
- [ ] Publish to the Chrome Web Store

---

## ⚠️ Known limitations

- `ScriptProcessorNode` is deprecated (though still supported) — an `AudioWorklet` rewrite is on the roadmap.
- Sites that already attach their own `AudioContext` to the `<video>` element may block the analyser from attaching — you'll see a warning in the DevTools console if this happens.
- The offscreen document is created lazily the first time music-skip is used on a page; expect a brief delay (model load) before it kicks in.
- Ad breaks are not currently distinguished from regular content.

---

## 🤝 Contributing

Issues and PRs are welcome — see [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for attribution of the bundled model and runtime.

---

## 📄 License

MIT — see [`LICENSE`](./LICENSE) for details.

<div align="center">
<sub>Built because dead air is the enemy of a good watch.</sub>
</div>
