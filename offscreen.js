// ===== Offscreen document: runs the actual Silero VAD model =====
// This is the only place in the extension that touches ONNX Runtime Web.
// Content scripts never load the model directly — they just resample
// audio to 16kHz, chop it into 512-sample frames, and ask this page
// (via chrome.runtime messages) "is this frame speech?".

/* global ort */

const STATE_SHAPE = [2, 1, 128]; // Silero VAD v5's combined LSTM state shape
const SAMPLE_RATE = 16000n; // BigInt: the model's "sr" input is int64

ort.env.wasm.numThreads = 1;   // avoids requiring SharedArrayBuffer / cross-origin isolation
ort.env.wasm.simd = true;
ort.env.wasm.proxy = false;    // run inference on this page's own thread, no extra worker file
ort.env.wasm.wasmPaths = chrome.runtime.getURL("lib/ort/");

console.log("[Silence Skipper] offscreen document loaded, loading Silero VAD model...");

const sessionPromise = ort.InferenceSession.create("models/silero_vad.onnx", {
  executionProviders: ["wasm"]
}).then((session) => {
  console.log("[Silence Skipper] Silero VAD model loaded successfully");
  return session;
}).catch((e) => {
  console.error("[Silence Skipper] failed to load Silero VAD model:", e);
  return null;
});

// Per-video recurrent state, keyed by the streamId each content script
// generates for itself. The model needs its own running state per
// independent audio stream (it's not statelessper-frame).
const streamStates = new Map();

function freshState() {
  return new Float32Array(STATE_SHAPE[0] * STATE_SHAPE[1] * STATE_SHAPE[2]);
}

async function runInference(streamId, samples, reset) {
  const session = await sessionPromise;
  if (!session) return { ok: false, error: "model-not-loaded" };

  if (reset || !streamStates.has(streamId)) {
    streamStates.set(streamId, freshState());
  }
  const state = streamStates.get(streamId);

  const feeds = {
    input: new ort.Tensor("float32", Float32Array.from(samples), [1, samples.length]),
    state: new ort.Tensor("float32", state, STATE_SHAPE),
    sr: new ort.Tensor("int64", BigInt64Array.from([SAMPLE_RATE]), [])
  };

  const results = await session.run(feeds);
  streamStates.set(streamId, Float32Array.from(results.stateN.data));
  const probability = results.output.data[0];
  return { ok: true, probability };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "vad-infer") {
    runInference(message.streamId, message.samples, message.reset)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async response
  }
  if (message?.type === "vad-end-stream") {
    streamStates.delete(message.streamId);
    sendResponse({ ok: true });
    return true;
  }
});
