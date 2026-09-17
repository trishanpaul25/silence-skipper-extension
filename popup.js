const DEFAULTS = {
  enabled: true,
  silenceThresholdDb: -45,
  minSilenceMs: 350,
  maxSpeed: 4,
  skipMusicOnly: false,
  musicSpeed: 2,
  minMusicMs: 600,
  preservePitch: true,
  showIndicator: true
};

const els = {
  enabled: document.getElementById("enabled"),
  threshold: document.getElementById("threshold"),
  thresholdVal: document.getElementById("thresholdVal"),
  minSilence: document.getElementById("minSilence"),
  minSilenceVal: document.getElementById("minSilenceVal"),
  maxSpeed: document.getElementById("maxSpeed"),
  maxSpeedVal: document.getElementById("maxSpeedVal"),
  skipMusicOnly: document.getElementById("skipMusicOnly"),
  musicSpeed: document.getElementById("musicSpeed"),
  musicSpeedVal: document.getElementById("musicSpeedVal"),
  minMusic: document.getElementById("minMusic"),
  minMusicVal: document.getElementById("minMusicVal"),
  preservePitch: document.getElementById("preservePitch"),
  showIndicator: document.getElementById("showIndicator")
};

function render(s) {
  els.enabled.checked = s.enabled;
  els.threshold.value = s.silenceThresholdDb;
  els.thresholdVal.textContent = `${s.silenceThresholdDb} dB`;
  els.minSilence.value = s.minSilenceMs;
  els.minSilenceVal.textContent = `${s.minSilenceMs} ms`;
  els.maxSpeed.value = s.maxSpeed;
  els.maxSpeedVal.textContent = `${s.maxSpeed}x`;
  els.skipMusicOnly.checked = s.skipMusicOnly;
  els.musicSpeed.value = s.musicSpeed;
  els.musicSpeedVal.textContent = `${s.musicSpeed}x`;
  els.minMusic.value = s.minMusicMs;
  els.minMusicVal.textContent = `${s.minMusicMs} ms`;
  els.preservePitch.checked = s.preservePitch;
  els.showIndicator.checked = s.showIndicator;
}

chrome.storage.sync.get(DEFAULTS, render);

function bindCheckbox(el, key) {
  el.addEventListener("change", () => chrome.storage.sync.set({ [key]: el.checked }));
}
function bindRange(el, valEl, key, formatter) {
  el.addEventListener("input", () => {
    const v = Number(el.value);
    valEl.textContent = formatter(v);
    chrome.storage.sync.set({ [key]: v });
  });
}

bindCheckbox(els.enabled, "enabled");
bindCheckbox(els.skipMusicOnly, "skipMusicOnly");
bindCheckbox(els.preservePitch, "preservePitch");
bindCheckbox(els.showIndicator, "showIndicator");

bindRange(els.threshold, els.thresholdVal, "silenceThresholdDb", (v) => `${v} dB`);
bindRange(els.minSilence, els.minSilenceVal, "minSilenceMs", (v) => `${v} ms`);
bindRange(els.maxSpeed, els.maxSpeedVal, "maxSpeed", (v) => `${v}x`);
bindRange(els.musicSpeed, els.musicSpeedVal, "musicSpeed", (v) => `${v}x`);
bindRange(els.minMusic, els.minMusicVal, "minMusicMs", (v) => `${v} ms`);
