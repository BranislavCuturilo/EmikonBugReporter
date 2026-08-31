// Tab video recording, and the reason it is more than one step.
//
// The helpdesk accepts png/jpg/webp/gif/pdf and NOTHING else -- there is no
// video type in the serializer at all. So a recording can never be the
// attachment; it is a source that this module renders down to still frames the
// ticket CAN carry. The .webm is offered as a local download for the times a
// colleague needs to watch the actual thing.
//
// MediaRecorder needs a DOM and a live MediaStream, neither of which exists in
// an MV3 service worker, so the capture runs in an offscreen document. Blobs do
// not survive chrome.runtime.sendMessage, so the offscreen document parks the
// recording in IndexedDB (shared origin) and returns only its key.

import { getBlob, deleteBlob } from "./session-store.js";

const OFFSCREEN_PATH = "src/offscreen/offscreen.html";
const MAX_FRAMES = 6;          // more than this and the ticket is a flipbook
const FRAME_TYPE = "image/png";

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Snimanje kartice za prilog uz prijavu greške.",
  });
}

const ask = (type, payload = {}) =>
  chrome.runtime.sendMessage({ target: "offscreen", type, ...payload }).then((r) => {
    if (!r?.ok) throw new Error(r?.error || "snimanje nije uspelo");
    return r.data;
  });

export async function startRecording(tabId) {
  await ensureOffscreen();
  // The stream id must be minted for the target tab BEFORE the offscreen
  // document asks for the stream; it is single-use and expires quickly.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  return ask("REC_START", { streamId });
}

/**
 * Stop, then render the recording down to what a ticket can actually carry.
 * Returns `[{blob, name, caption}]` -- evenly spaced frames, oldest first.
 */
export async function stopRecording({ keepWebm = true } = {}) {
  const { blobKey, durationMs } = await ask("REC_STOP");
  const webm = await getBlob(blobKey);
  if (!webm) return [];

  if (keepWebm) {
    // Kept OUTSIDE the ticket, deliberately: the frames are the evidence, the
    // video is the thing you send someone who says "show me".
    const url = URL.createObjectURL(webm);
    try {
      await chrome.downloads.download({
        url,
        filename: `bug-snimak-${Date.now()}.webm`,
        saveAs: false,
      });
    } catch {
      /* a blocked download must not lose the frames */
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  const frames = await extractFrames(webm, durationMs);
  await deleteBlob(blobKey);
  return frames;
}

/**
 * Seek to N evenly spaced points and paint each to a canvas.
 *
 * Seeking a MediaRecorder .webm is unreliable until the browser knows the
 * duration -- a stream-recorded file reports Infinity. The nudge below (seek
 * far past the end, wait for the browser to correct it) is the standard fix;
 * without it every frame comes out identical to the first.
 */
async function extractFrames(webm, durationMs) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.src = URL.createObjectURL(webm);

  try {
    await once(video, "loadedmetadata");
    let duration = video.duration;
    if (!isFinite(duration) || duration <= 0) {
      video.currentTime = 1e6;
      await once(video, "timeupdate", 3000).catch(() => {});
      duration = isFinite(video.duration) && video.duration > 0
        ? video.duration
        : Math.max(1, (durationMs || 0) / 1000);
      video.currentTime = 0;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext("2d");

    const n = Math.min(MAX_FRAMES, Math.max(2, Math.round(duration / 3)));
    const out = [];
    for (let i = 0; i < n; i++) {
      // Never seek to exactly 0 or exactly the end: both routinely decode to a
      // black frame, and a ticket full of black rectangles is worse than none.
      const t = duration * ((i + 0.5) / n);
      video.currentTime = t;
      await once(video, "seeked", 3000).catch(() => {});
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, FRAME_TYPE));
      if (!blob) continue;
      out.push({
        blob,
        name: `kadar-${String(i + 1).padStart(2, "0")}.png`,
        caption: `Snimak, ${t.toFixed(1)}s`,
      });
    }
    return out;
  } finally {
    URL.revokeObjectURL(video.src);
  }
}

function once(el, event, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      el.removeEventListener(event, on);
      reject(new Error(`isteklo cekanje na ${event}`));
    }, timeoutMs);
    const on = () => {
      clearTimeout(timer);
      el.removeEventListener(event, on);
      resolve();
    };
    el.addEventListener(event, on, { once: true });
  });
}
