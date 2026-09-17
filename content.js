// ===== Silence Skipper content script =====
// Attaches to every <video> on the page, watches its audio in real time,
// and speeds up playback during silence AND (optionally) during
// music-with-no-speech stretches, dropping back to normal speed the
// instant actual speech is detected.

const DEFAULTS = {
  enabled: true,

  // Full silence detection
  silenceThresholdDb: -45,   // volume (dB) below which we call it "silence"
  minSilenceMs: 350,         // how long it must stay silent before speeding up
  maxSpeed: 4,               // playback rate during full silence

  // Music-with-no-speech detection (new)
  skipMusicOnly: false,      // master toggle for this feature
  musicSpeed: 2,             // playback rate during music-only stretches
  minMusicMs: 600,           // how long it must look "music-only" before speeding up
  speechEnergyThreshold: 0.16,  // min normalized energy in the speech band to count as "speech present"
  speechModulationThreshold: 0.18, // min variability in speech-band energy to count as "speech-like"

  // General
  normalSpeed: 1,
  rampMs: 150,
  preservePitch: true,
  showIndicator: true
};

const SPEECH_BAND_LO_HZ = 300;
const SPEECH_BAND_HI_HZ = 3400;
const MODULATION_WINDOW = 10; // number of 50ms polls (~500ms) used to judge speech-like variability

let settings = { ...DEFAULTS };

chrome.storage.sync.get(DEFAULTS, (stored) => {
  settings = { ...DEFAULTS, ...stored };
});
chrome.storage.onChanged.addListener((changes) => {
  for (const key in changes) settings[key] = changes[key].newValue;
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

// WeakMap for lookup-by-video, plus a plain array so we can iterate
// (needed for the enabled/disabled reset above and cleanup).
const managedVideos = new WeakMap();
const allStates = new Set();

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

function setRate(state, rate) {
  rampTo(state.video, rate, settings.rampMs);
}

// ---- On-screen "speeding up" badge ----

function ensureBadge(state) {
  if (state.badge) return state.badge;
  const badge = document.createElement("div");
  Object.assign(badge.style, {
    position: "fixed",
    zIndex: 2147483647,
    background: "rgba(0,0,0,0.75)",
    color: "#fff",
    font: "600 11px -apple-system, Segoe UI, Roboto, sans-serif",
    padding: "3px 7px",
    borderRadius: "4px",
    pointerEvents: "none",
    opacity: "0",
    transition: "opacity 120ms ease",
    top: "0px",
    left: "0px"
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
  const visible =
    rect.width > 0 && rect.height > 0 &&
    rect.bottom > 0 && rect.right > 0 &&
    rect.top < window.innerHeight && rect.left < window.innerWidth;

  if (!visible) {
    badge.style.opacity = "0";
    return;
  }
  badge.style.top = `${Math.max(rect.top + 8, 0)}px`;
  badge.style.left = `${Math.max(rect.left + 8, 0)}px`;
  const label = state.mode === "silent" ? "\u23E9 silence" : "\u23E9 music (no speech)";
  const speed = state.mode === "silent" ? settings.maxSpeed : settings.musicSpeed;
  badge.textContent = `${label} ${speed}x`;
  badge.style.opacity = "1";
}

// ---- Core analysis ----

function attachAnalyser(video) {
  if (managedVideos.has(video)) return;

  let audioCtx, source, analyser;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    source = audioCtx.createMediaElementSource(video);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    analyser.connect(audioCtx.destination); // must reconnect or video goes silent
  } catch (e) {
    console.warn("[Silence Skipper] could not attach analyser:", e);
    return;
  }

  applyPitchSetting(video);

  const timeData = new Uint8Array(analyser.fftSize);
  const freqData = new Uint8Array(analyser.frequencyBinCount);
  const binHz = audioCtx.sampleRate / analyser.fftSize;
  const speechBinLo = Math.max(0, Math.floor(SPEECH_BAND_LO_HZ / binHz));
  const speechBinHi = Math.min(freqData.length - 1, Math.ceil(SPEECH_BAND_HI_HZ / binHz));

  const state = {
    video, audioCtx, analyser,
    silentSince: null,
    musicSince: null,
    mode: "normal",           // "normal" | "silent" | "music"
    rampInterval: null,
    pollInterval: null,
    badge: null,
    speechLevelHistory: []
  };
  managedVideos.set(video, state);
  allStates.add(state);

  state.pollInterval = setInterval(() => {
    if (!settings.enabled || video.paused || video.ended) return;
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});

    // Overall volume (time domain RMS) — used for true silence detection.
    analyser.getByteTimeDomainData(timeData);
    let sumSquares = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = (timeData[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / timeData.length);
    const db = dbFromRms(rms);
    const isSilent = db < settings.silenceThresholdDb;

    // Speech-band energy + its short-term variability — used to guess
    // whether audible sound is speech or just music/ambience. This is a
    // heuristic (real speech/music classification needs more than this)
    // but works reasonably well for typical dialogue-over-music content.
    let speechLevel = 0;
    let hasSpeechLikeAudio = true;
    if (!isSilent && settings.skipMusicOnly) {
      analyser.getByteFrequencyData(freqData);
      let sum = 0;
      for (let i = speechBinLo; i <= speechBinHi; i++) sum += freqData[i];
      speechLevel = sum / (speechBinHi - speechBinLo + 1) / 255; // normalized 0..1

      const hist = state.speechLevelHistory;
      hist.push(speechLevel);
      if (hist.length > MODULATION_WINDOW) hist.shift();

      const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
      const variance = hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length;
      const stdev = Math.sqrt(variance);
      const cv = mean > 0 ? stdev / mean : 0; // coefficient of variation

      const enoughHistory = hist.length >= MODULATION_WINDOW;
      const energyLooksLikeSpeech = mean >= settings.speechEnergyThreshold;
      const modulationLooksLikeSpeech = cv >= settings.speechModulationThreshold;

      // Only start judging "music-only" once we have enough history to
      // avoid a burst of false positives right as audio starts.
      hasSpeechLikeAudio = !enoughHistory || (energyLooksLikeSpeech && modulationLooksLikeSpeech);
    }

    if (isSilent) {
      state.musicSince = null;
      if (state.silentSince === null) state.silentSince = performance.now();
      const silentFor = performance.now() - state.silentSince;
      if (silentFor >= settings.minSilenceMs && state.mode !== "silent") {
        state.mode = "silent";
        setRate(state, settings.maxSpeed);
      }
    } else if (settings.skipMusicOnly && !hasSpeechLikeAudio) {
      state.silentSince = null;
      if (state.musicSince === null) state.musicSince = performance.now();
      const musicFor = performance.now() - state.musicSince;
      if (musicFor >= settings.minMusicMs && state.mode !== "music") {
        state.mode = "music";
        setRate(state, settings.musicSpeed);
      }
    } else {
      state.silentSince = null;
      state.musicSince = null;
      if (state.mode !== "normal") {
        state.mode = "normal";
        setRate(state, settings.normalSpeed);
      }
    }

    updateBadge(state);
  }, 50);

  video.addEventListener("pause", () => clearInterval(state.rampInterval));

  const cleanupObserver = new MutationObserver(() => {
    if (!document.contains(video)) {
      clearInterval(state.pollInterval);
      clearInterval(state.rampInterval);
      if (state.badge) state.badge.remove();
      try { audioCtx.close(); } catch (e) {}
      managedVideos.delete(video);
      allStates.delete(state);
      cleanupObserver.disconnect();
    }
  });
  cleanupObserver.observe(document.body, { childList: true, subtree: true });
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
