// ===== Background service worker =====
// MV3 service workers have no DOM/AudioContext access, so the actual
// ONNX Runtime Web + Silero VAD inference happens in an "offscreen
// document" (a hidden extension page with full DOM access). This file's
// only job is to create that document on demand and keep exactly one
// instance of it alive.

const OFFSCREEN_URL = "offscreen.html";
let creatingOffscreen = null; // de-dupes concurrent creation calls

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime
    .getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    })
    .catch((e) => {
      throw new Error(`getContexts failed: ${e.message}`);
    });

  if (existing && existing.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["WORKERS"],
    justification:
      "Runs an ONNX Runtime Web model (Silero VAD) for real-time speech detection; requires WebAssembly support unavailable to a service worker."
  });

  try {
    await creatingOffscreen;
  } catch (e) {
    // "Only a single offscreen document may be created" is a benign race
    // (another call won the creation); anything else is a real failure
    // and must propagate so the caller (and ultimately the content
    // script's console) actually sees it instead of a silent no-op.
    if (!/single offscreen document/i.test(e.message)) {
      creatingOffscreen = null;
      throw new Error(`createDocument failed: ${e.message}`);
    }
  }
  creatingOffscreen = null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ensure-offscreen") {
    console.log("[Silence Skipper] background received ensure-offscreen request");
    ensureOffscreenDocument()
      .then(() => {
        console.log("[Silence Skipper] offscreen document ready");
        sendResponse({ ok: true });
      })
      .catch((e) => {
        console.error("[Silence Skipper] offscreen setup failed:", e);
        sendResponse({ ok: false, error: e.message });
      });
    return true; // keep the message channel open for the async response
  }
  // All other message types ("vad-infer", "vad-end-stream") are handled
  // directly by offscreen.js — this listener ignores them.
});
