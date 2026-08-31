// Offscreen document: the only context in this extension with a DOM AND access
// to a MediaStream. Its whole job is MediaRecorder.
//
// It never returns the recording over messaging -- a Blob does not survive
// chrome.runtime.sendMessage. It writes it into IndexedDB, which the panel
// shares, and returns the key.

import { putBlob } from "../lib/session-store.js";

let recorder = null;
let chunks = [];
let stream = null;
let startedAt = 0;

async function start(streamId) {
  if (recorder) throw new Error("snimanje je vec u toku");

  stream = await navigator.mediaDevices.getUserMedia({
    video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    // Tab audio is captured only to keep it audible; muting the element would
    // silence the tab for the user, which is a surprising thing for a bug
    // reporter to do to someone mid-reproduction.
    audio: false,
  });

  chunks = [];
  // VP9 where available: a long screen recording in VP8 is several times larger
  // for the same legibility, and every byte here is a byte the frame extractor
  // has to decode.
  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : "video/webm";
  recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 });
  recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  recorder.start(1000);   // timeslice, so a crash still leaves usable chunks
  startedAt = Date.now();
  return { started: true };
}

function stop() {
  return new Promise((resolve, reject) => {
    if (!recorder) return reject(new Error("nema snimanja u toku"));
    const durationMs = Date.now() - startedAt;
    recorder.onstop = async () => {
      try {
        const blob = new Blob(chunks, { type: "video/webm" });
        const blobKey = await putBlob(blob);
        resolve({ blobKey, durationMs, bytes: blob.size });
      } catch (e) {
        reject(e);
      } finally {
        for (const t of stream?.getTracks() || []) t.stop();
        recorder = null;
        stream = null;
        chunks = [];
      }
    };
    recorder.stop();
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;
  const run =
    msg.type === "REC_START" ? start(msg.streamId)
    : msg.type === "REC_STOP" ? stop()
    : null;
  if (!run) return false;
  run
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
