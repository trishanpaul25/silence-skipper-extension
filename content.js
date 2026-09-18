// ===== Silence Skipper content script (v2 — ML-based speech detection) =====
// Attaches to every <video> on the page. Full silence is still detected
// locally (fast, cheap, no model needed). Whether audible sound is
// SPEECH or MUSIC/ambience-only is now decided by a real model — Silero
// VAD — running in the extension's offscreen document, instead of the
// old frequency-band heuristic.

const DEFAULTS = {
  enabled: true,

  // Full silence detection (unchanged from v1 — no model needed for this)
  silenceThresholdDb: -45,
  minSilenceMs: 350,
  maxSpeed: 4,

  // Music-with-no-speech detection (now ML-based)
  skipMusicOnly: false,
  musicSpeed: 2,
  minMusicMs: 900,
  vadSpeechThreshold: 0.35,  // Silero VAD probability above this = "speech"

  // General
  normalSpeed: 1,
  rampMs: 150,
  preservePitch: true,
  showIndicator: true
};

const VAD_FRAME_SAMPLES = 512; // Silero VAD's expected chunk size at 16kHz
const VAD_SAMPLE_RATE = 16000;

let settings = { ...DEFAULTS };

chrome.storage.sync.get(DEFAULTS, (stored) => {
  settings = { ...DEFAULTS, ...stored };
  console.log("[Silence Skipper] settings loaded, skipMusicOnly =", settings.skipMusicOnly);
});
chrome.storage.onChanged.addListener((changes) => {
  for (const key in changes) settings[key] = changes[key].newValue;
  if ("skipMusicOnly" in changes) {
    console.log("[Silence Skipper] skipMusicOnly changed to", changes.skipMusicOnly.newValue);
  }
  if ("enabled" in changes && !changes.enabled.newValue) {
    for (const state of allStates) {
      state.mode = "normal";
      setRate(state, settings.normalSpeed);
      updateBadge(state);
    }
  }
  if ("preservePitch" in changes) {
    for (const state of allStates) applyPitchSetting(state.video);
  }
});

const managedVideos = new WeakMap();
const allStates = new Set();

// ---- One-time offscreen-document handshake ----
// Only bother waking up the model at all if music-skip is actually on.
let offscreenReadyPromise = null;
function ensureOffscreen() {
  if (!offscreenReadyPromise) {
    console.log("[Silence Skipper] requesting offscreen document...");
    offscreenReadyPromise = chrome.runtime
      .sendMessage({ type: "ensure-offscreen" })
      .then((res) => {
        if (!res?.ok) {
          console.error("[Silence Skipper] offscreen document not ready:", res?.error);
          offscreenReadyPromise = null; // allow retry on the next frame
          throw new Error(res?.error || "unknown offscreen failure");
        }
      })
      .catch((e) => {
        console.error("[Silence Skipper] could not start VAD model:", e);
        offscreenReadyPromise = null; // allow retry later
        throw e;
      });
  }
  return offscreenReadyPromise;
}

function dbFromRms(rms) {
  return 20 * Math.log10(Math.max(rms, 1e-8));
}

function applyPitchSetting(video) {
  const preserve = !!settings.preservePitch;
  try { video.preservesPitch = preserve; } catch (e) {}
  try { video.webkitPreservesPitch = preserve; } catch (e) {}
  try { video.mozPreservesPitch = preserve; } catch (e) {}
}

function rampTo(video, targetRate, ms) {
  const state = managedVideos.get(video);
  if (!state) return;
  clearInterval(state.rampInterval);
  const startRate = video.playbackRate;
  const startTime = performance.now();
  state.rampInterval = setInterval(() => {
    const t = Math.min(1, (performance.now() - startTime) / ms);
    const nextRate = startRate + (targetRate - startRate) * t;
    try { video.playbackRate = Number(nextRate.toFixed(3)); } catch (e) {}
    if (t >= 1) clearInterval(state.rampInterval);
  }, 30);
}
function setRate(state, rate) { rampTo(state.video, rate, settings.rampMs); }

// ---- On-screen badge ----
function ensureBadge(state) {
  if (state.badge) return state.badge;
  const badge = document.createElement("div");
  Object.assign(badge.style, {
    position: "fixed", zIndex: 2147483647, background: "rgba(0,0,0,0.75)",
    color: "#fff", font: "600 11px -apple-system, Segoe UI, Roboto, sans-serif",
    padding: "3px 7px", borderRadius: "4px", pointerEvents: "none",
    opacity: "0", transition: "opacity 120ms ease", top: "0px", left: "0px"
  });
  document.body.appendChild(badge);
  state.badge = badge;
  return badge;
}
function updateBadge(state) {
  if (!settings.showIndicator || state.mode === "normal" || !settings.enabled) {
    if (state.badge) state.badge.style.opacity = "0";
    return;
  }
  const badge = ensureBadge(state);
  const rect = state.video.getBoundingClientRect();
  const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
    rect.top < window.innerHeight && rect.left < window.innerWidth;
  if (!visible) { badge.style.opacity = "0"; return; }
  badge.style.top = `${Math.max(rect.top + 8, 0)}px`;
  badge.style.left = `${Math.max(rect.left + 8, 0)}px`;
  const label = state.mode === "silent" ? "\u23E9 silence" : "\u23E9 music (no speech)";
  const speed = state.mode === "silent" ? settings.maxSpeed : settings.musicSpeed;
  badge.textContent = `${label} ${speed}x`;
  badge.style.opacity = "1";
}

// ---- Simple linear-interpolation downsampler (native rate -> 16kHz) ----
// Not audiophile-grade (no anti-aliasing low-pass filter first), but more
// than good enough to feed a voice-activity model.
class Downsampler {
  constructor(inputRate, outputRate) {
    this.ratio = inputRate / outputRate;
    this.phase = 0;
  }
  process(input) {
    const outLen = Math.max(0, Math.floor((input.length - this.phase) / this.ratio));
    const out = new Float32Array(outLen);
    let pos = this.phase;
    for (let i = 0; i < outLen; i++) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const s0 = input[i0] ?? 0;
      const s1 = input[i0 + 1] ?? s0;
      out[i] = s0 * (1 - frac) + s1 * frac;
      pos += this.ratio;
    }
    this.phase = pos - input.length;
    return out;
  }
}

function attachAnalyser(video) {
  if (managedVideos.has(video)) return;

  let audioCtx, source, analyser, scriptNode, silentGain;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    source = audioCtx.createMediaElementSource(video);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    analyser.connect(audioCtx.destination); // audible path

    // Second tap, purely for feeding the VAD model. ScriptProcessorNode
    // must reach audioCtx.destination (via a silent gain) to keep firing
    // reliably in every browser — it does not add any audible output.
    scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
    silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;
    source.connect(scriptNode);
    scriptNode.connect(silentGain);
    silentGain.connect(audioCtx.destination);
  } catch (e) {
    console.warn("[Silence Skipper] could not attach analyser:", e);
    return;
  }

  applyPitchSetting(video);

  const timeData = new Uint8Array(analyser.fftSize);

  const state = {
    video, audioCtx, analyser, scriptNode, silentGain,
    silentSince: null,
    musicSince: null,
    mode: "normal",
    rampInterval: null,
    pollInterval: null,
    badge: null,
    streamId: (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`),
    downsampler: new Downsampler(audioCtx.sampleRate, VAD_SAMPLE_RATE),
    frameBuffer: new Float32Array(0),
    vadPending: false,
    lastSpeechProb: 1, // assume speech until proven otherwise (fail safe)
    smoothedSpeechProb: 1,
  };
  managedVideos.set(video, state);
  allStates.add(state);

  // ---- Fast, local, model-free silence detection ----
  state.pollInterval = setInterval(() => {
    if (!settings.enabled || video.paused || video.ended) return;
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});

    analyser.getByteTimeDomainData(timeData);
    let sumSquares = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = (timeData[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / timeData.length);
    const isSilent = dbFromRms(rms) < settings.silenceThresholdDb;

    if (isSilent) {
      state.musicSince = null;
      if (state.silentSince === null) state.silentSince = performance.now();
      const silentFor = performance.now() - state.silentSince;
      if (silentFor >= settings.minSilenceMs && state.mode !== "silent") {
        state.mode = "silent";
        setRate(state, settings.maxSpeed);
      }
    } else {
      state.silentSince = null;
      if (settings.skipMusicOnly) {
        // Speech/music decision now comes from the VAD model (see
        // onaudioprocess below), which continuously updates
        // state.smoothedSpeechProb. We just apply hysteresis here.
        const looksLikeSpeech = state.smoothedSpeechProb >= settings.vadSpeechThreshold;

        // Diagnostic: print the live probability roughly once a second so
        // you can see actual numbers and pick a threshold that fits your
        // content, instead of guessing blind.
        const now = performance.now();
        if (!state.lastProbLog || now - state.lastProbLog > 1000) {
          state.lastProbLog = now;
          console.log(
            `[Silence Skipper] speech probability: raw=${state.lastSpeechProb.toFixed(2)} ` +
            `smoothed=${state.smoothedSpeechProb.toFixed(2)} threshold=${settings.vadSpeechThreshold} ` +
            `frameRms=${(state.lastFrameRms ?? -1).toFixed(4)} ` +
            `→ ${looksLikeSpeech ? "speech" : "music"}`
          );
        }

        if (!looksLikeSpeech) {
          if (state.musicSince === null) state.musicSince = performance.now();
          const musicFor = performance.now() - state.musicSince;
          if (musicFor >= settings.minMusicMs && state.mode !== "music") {
            state.mode = "music";
            setRate(state, settings.musicSpeed);
          }
        } else {
          state.musicSince = null;
          if (state.mode !== "normal") {
            state.mode = "normal";
            setRate(state, settings.normalSpeed);
          }
        }
      } else if (state.mode !== "normal") {
        state.mode = "normal";
        setRate(state, settings.normalSpeed);
      }
    }
    updateBadge(state);
  }, 50);

  // ---- Feed raw PCM to the VAD model (only when the feature is on) ----
  scriptNode.onaudioprocess = (event) => {
    if (!settings.enabled || !settings.skipMusicOnly || video.paused) return;
    if (!state.loggedGatePassed) {
      console.log("[Silence Skipper] audio tap active, feeding VAD (skipMusicOnly is on)");
      state.loggedGatePassed = true;
    }

    const input = event.inputBuffer.getChannelData(0);
    const resampled = state.downsampler.process(input);

    // Append to the rolling frame buffer.
    const combined = new Float32Array(state.frameBuffer.length + resampled.length);
    combined.set(state.frameBuffer, 0);
    combined.set(resampled, state.frameBuffer.length);
    state.frameBuffer = combined;

    // Emit one 512-sample frame per callback at most — if inference is
    // still in flight from the previous frame, just keep buffering and
    // skip sending (avoids piling up overlapping requests).
    if (state.frameBuffer.length >= VAD_FRAME_SAMPLES && !state.vadPending) {
      const frame = state.frameBuffer.slice(0, VAD_FRAME_SAMPLES);
      state.frameBuffer = state.frameBuffer.slice(VAD_FRAME_SAMPLES);
      state.vadPending = true;

      // Diagnostic: loudness of the exact audio being sent to the model,
      // independent of what the model says about it.
      let sumSquares = 0;
      for (let i = 0; i < frame.length; i++) sumSquares += frame[i] * frame[i];
      state.lastFrameRms = Math.sqrt(sumSquares / frame.length);

      ensureOffscreen()
        .then(() =>
          chrome.runtime.sendMessage({
            type: "vad-infer",
            streamId: state.streamId,
            samples: Array.from(frame)
          })
        )
        .then((res) => {
          if (res?.ok) {
            if (!state.loggedFirstResult) {
              console.log("[Silence Skipper] VAD model responding, first probability:", res.probability);
              state.loggedFirstResult = true;
            }
            state.lastSpeechProb = res.probability;
            // EMA smoothing: a lone low-confidence frame (common when
            // speech overlaps loud background music) won't immediately
            // flip the decision — it takes a few consecutive low frames.
            const alpha = 0.35;
            state.smoothedSpeechProb =
              state.smoothedSpeechProb * (1 - alpha) + res.probability * alpha;
          }
        })
        .catch(() => {
          // Extension context can go away mid-navigation; fail open
          // (treat as speech) rather than get stuck speeding up forever.
          state.lastSpeechProb = 1;
          state.smoothedSpeechProb = 1;
        })
        .finally(() => { state.vadPending = false; });
    } else if (state.frameBuffer.length > VAD_FRAME_SAMPLES * 4) {
      // Safety valve: if we somehow fall behind, drop old buffered audio
      // rather than let this array grow unbounded.
      state.frameBuffer = state.frameBuffer.slice(-VAD_FRAME_SAMPLES);
    }
  };

  video.addEventListener("pause", () => clearInterval(state.rampInterval));

  const cleanupObserver = new MutationObserver(() => {
    if (!document.contains(video)) {
      clearInterval(state.pollInterval);
      clearInterval(state.rampInterval);
      scriptNode.onaudioprocess = null;
      if (state.badge) state.badge.remove();
      chrome.runtime.sendMessage({ type: "vad-end-stream", streamId: state.streamId }).catch(() => {});
      try { audioCtx.close(); } catch (e) {}
      managedVideos.delete(video);
      allStates.delete(state);
      cleanupObserver.disconnect();
    }
  });
  cleanupObserver.observe(document.body, { childList: true, subtree: true });

  if (settings.skipMusicOnly) ensureOffscreen();
}

function scanForVideos(root = document) {
  root.querySelectorAll?.("video").forEach((video) => {
    if (video.readyState >= 1) attachAnalyser(video);
    else video.addEventListener("loadedmetadata", () => attachAnalyser(video), { once: true });
  });
}

scanForVideos();

const domObserver = new MutationObserver((mutations) => {
  for (const m of mutations) {
    m.addedNodes.forEach((node) => {
      if (node.nodeType !== 1) return;
      if (node.tagName === "VIDEO") attachAnalyser(node);
      else scanForVideos(node);
    });
  }
});
domObserver.observe(document.documentElement, { childList: true, subtree: true });
