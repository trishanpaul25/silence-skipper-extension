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
<img src="assets\image.png" alt="Demo GIF placeholder" width="600"/>
<br/>
<sub>👆 Replace this with a real demo GIF/screen recording before publishing</sub>
</div>

---

## ✨ Features

| | |
|---|---|
| 🔇 **Silence skipping** | Detects true silence and ramps playback speed up until sound returns |
| 🎵 **Music-only skipping** *(experimental)* | Heuristically detects stretches of music/ambience with no speech and speeds through those too |
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
│  on the page │     │  AnalyserNode     │     │  + frequency check │
└─────────────┘     └──────────────────┘     └─────────┬──────────┘
                                                          │
                                     ┌────────────────────┼────────────────────┐
                                     ▼                    ▼                    ▼
                              🔇 Silence            🎵 Music-only          🗣️ Speech
                          (below dB threshold)  (heuristic: low energy   (normal audio)
                                                 + low variability in
                                                  speech-band frequencies)
                                     │                    │                    │
                                     ▼                    ▼                    ▼
                              Ramp to maxSpeed     Ramp to musicSpeed    Ramp to 1x
```

A browser extension can't "look into the future" of a stream, so instead of jump-cutting, it **ramps `playbackRate` up smoothly** during silence/music and back down the instant real speech is detected — which feels almost like a skip but works live, on any video, including streams.

The music-vs-speech distinction is a **heuristic**, not a trained model: it looks at how much audio energy sits in the human speech frequency band (~300Hz–3400Hz) and how much that energy fluctuates over time (speech is choppy and syllable-driven; music/ambience tends to be steadier). It's not perfect — see the [roadmap](#-roadmap) for where this is headed.

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
| Skip music-only parts | `Off` | Enables the experimental speech-vs-music heuristic |
| Speed during music-only | `2x` | Playback rate during detected music-with-no-speech |
| Min. duration before skipping (music) | `600 ms` | How long a music-only stretch must last before speeding up |
| Preserve voice pitch | `On` | Keeps pitch natural at high speeds instead of "chipmunk" audio |
| Show on-screen speed badge | `On` | Small indicator showing current mode/speed |

> 💡 Reload the video's tab after changing settings so the content script picks up new values.

---

## 🗺️ Roadmap

- [ ] Replace the frequency-heuristic music/speech detector with a lightweight **ML model** (e.g. [Silero VAD](https://github.com/snakers4/silero-vad) or a custom model run via **ONNX Runtime Web** / **TensorFlow.js**) for far more accurate speech detection
- [ ] Per-site custom presets (e.g. different defaults for YouTube vs. lecture platforms)
- [ ] Skip visual indicator styling options
- [ ] Keyboard shortcut to toggle on/off without opening the popup
- [ ] Firefox support (WebExtensions port)
- [ ] Publish to the Chrome Web Store

---

## ⚠️ Known limitations

- The music-vs-speech heuristic can misfire on unusual audio (e.g. rap over a beat, very flat/monotone speech, or spoken word with heavy background music).
- Sites that already attach their own `AudioContext` to the `<video>` element may block the analyser from attaching — you'll see a warning in the DevTools console if this happens.
- Ad breaks are not currently distinguished from regular content.

---

## 🤝 Contributing

Issues and PRs are welcome. If you're tackling the ML roadmap item, please open an issue first to discuss the approach (model choice, bundling strategy, size budget) before submitting a large PR.

---

## 📄 License

MIT — see [`LICENSE`](./LICENSE) for details.

<div align="center">
<sub>Built because dead air is the enemy of a good watch.</sub>
</div>
