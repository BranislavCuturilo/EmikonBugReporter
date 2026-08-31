// The three ways to take a picture.
//
//   viewport  what is on screen now
//   region    drag a rectangle, like Lightshot
//   full      the whole scrollable page
//
// Ordering matters in all three and is the same: the picture is taken FIRST,
// and any UI of ours appears only afterwards, on top of the frozen image. That
// is what keeps the selection rectangle out of the screenshot, and it also
// means the page cannot change under the user while they are choosing.

const CDP_VERSION = "1.3";

/**
 * Run a capture with our in-page overlay hidden.
 *
 * The overlay is drawn INSIDE the page, so without this it lands in every
 * screenshot. The content script answers OVERLAY_HIDE only after two animation
 * frames, so by the time this resolves the compositor has actually painted the
 * bar away -- a single frame is not enough and the bar still appears.
 *
 * A tab with no overlay simply refuses the message; that is the normal case in
 * side-panel mode and must not be treated as a failure.
 */
async function withOverlayHidden(tabId, fn) {
  let hidden = false;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "OVERLAY_HIDE" });
    hidden = true;
  } catch {
    /* no overlay mounted on this tab */
  }
  try {
    return await fn();
  } finally {
    if (hidden) chrome.tabs.sendMessage(tabId, { type: "OVERLAY_SHOW" }).catch(() => {});
  }
}

export const dataUrlToBlob = (dataUrl) => fetch(dataUrl).then((r) => r.blob());

/** What is visible right now. */
export async function captureViewport(tabId) {
  return withOverlayHidden(tabId, async () => {
    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    return dataUrlToBlob(dataUrl);
  });
}

/**
 * The whole scrollable page.
 *
 * Uses CDP when the debugger is already attached -- which it is during a
 * recording session -- because `captureBeyondViewport` renders the full page in
 * ONE shot. The alternative, scrolling and stitching, repeats every sticky
 * header once per slice and produces a picture with four navbars in it.
 *
 * Falls back to stitching only when CDP is unavailable, and says so in the
 * result so the caller can warn about the seams.
 */
export async function captureFullPage(tabId) {
  return withOverlayHidden(tabId, async () => {
    try {
      return { blob: await captureFullViaCdp(tabId), method: "cdp" };
    } catch (e) {
      const blob = await captureFullByStitching(tabId);
      return { blob, method: "stitch", warning: String(e?.message || e) };
    }
  });
}

/** Viewport capture WITHOUT touching the overlay -- for callers that have
 *  already hidden it and must not un-hide it halfway through. */
async function captureViewportRaw(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  return dataUrlToBlob(dataUrl);
}

async function captureFullViaCdp(tabId) {
  const attachedHere = await ensureAttached(tabId);
  try {
    await chrome.debugger.sendCommand({ tabId }, "Page.enable").catch(() => {});
    const metrics = await chrome.debugger.sendCommand({ tabId }, "Page.getLayoutMetrics");
    const size = metrics?.cssContentSize || metrics?.contentSize;
    if (!size?.width || !size?.height) throw new Error("stranica nije prijavila svoju velicinu");

    // Chrome refuses a capture past its texture limit and the failure is a
    // rejected promise with no useful text, so the cap is applied here where a
    // sentence can be attached to it.
    const MAX_PX = 16384;
    const height = Math.min(Math.ceil(size.height), MAX_PX);
    const width = Math.min(Math.ceil(size.width), MAX_PX);

    const shot = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    if (!shot?.data) throw new Error("Chrome nije vratio sliku");
    const blob = await dataUrlToBlob(`data:image/png;base64,${shot.data}`);
    return blob;
  } finally {
    if (attachedHere) await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

/** True when THIS call attached, so only this call detaches again -- tearing
 *  down a session's debugger would silently stop console and network capture. */
async function ensureAttached(tabId) {
  const targets = await chrome.debugger.getTargets();
  const already = targets.some((t) => t.tabId === tabId && t.attached);
  if (already) return false;
  await chrome.debugger.attach({ tabId }, CDP_VERSION);
  return true;
}

/**
 * Scroll, shoot, stitch. The fallback, and honestly the worse picture:
 * anything `position: fixed` is painted into every slice.
 *
 * captureVisibleTab is rate limited (roughly two calls a second); exceeding it
 * throws, so the pause between slices is not politeness, it is required.
 */
async function captureFullByStitching(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const [{ result: page }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      total: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      viewport: window.innerHeight,
      width: window.innerWidth,
      dpr: window.devicePixelRatio || 1,
      scrollY: window.scrollY,
    }),
  });

  const slices = Math.min(Math.ceil(page.total / page.viewport), 20);
  const canvas = new OffscreenCanvas(page.width * page.dpr, Math.min(page.total, 16384) * page.dpr);
  const ctx = canvas.getContext("2d");

  for (let i = 0; i < slices; i++) {
    const y = i * page.viewport;
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (top) => window.scrollTo(0, top),
      args: [y],
    });
    await new Promise((r) => setTimeout(r, 450));
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const bmp = await createImageBitmap(await dataUrlToBlob(dataUrl));
    ctx.drawImage(bmp, 0, y * page.dpr);
    bmp.close();
  }

  // Put the user back where they were. Leaving the page scrolled to the bottom
  // after a screenshot reads as the extension having navigated somewhere.
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (top) => window.scrollTo(0, top),
    args: [page.scrollY],
  });

  return canvas.convertToBlob({ type: "image/png" });
}

/**
 * Lightshot-style region select.
 *
 * Returns the cropped blob, or null when the user pressed Escape. The overlay
 * is drawn on top of the ALREADY captured image, so it can never appear in the
 * result and the page cannot shift mid-selection.
 */
export async function captureRegion(tabId) {
  // The whole selection runs with the bar hidden: the frozen image must not
  // contain it, and neither must the crop the user drags out of that image.
  return withOverlayHidden(tabId, () => regionFlow(tabId));
}

async function regionFlow(tabId) {
  const full = await captureViewportRaw(tabId);
  const bitmap = await createImageBitmap(full);

  // The image is the viewport at device pixels; the rectangle comes back in CSS
  // pixels. Deriving the ratio from the image itself rather than trusting
  // devicePixelRatio keeps it right on a zoomed page and on mixed-DPI setups.
  const [{ result: rect }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: regionPicker,
    args: [await blobToDataUrl(full)],
  });

  if (!rect) {
    bitmap.close();
    return null;                       // cancelled
  }

  const scale = bitmap.width / rect.viewportWidth;
  const x = Math.round(rect.x * scale);
  const y = Math.round(rect.y * scale);
  const w = Math.round(rect.w * scale);
  const h = Math.round(rect.h * scale);
  if (w < 4 || h < 4) {
    bitmap.close();
    return null;                       // a click, not a drag
  }

  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d").drawImage(bitmap, x, y, w, h, 0, 0, w, h);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/png" });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/**
 * Injected into the page. Everything it needs must be inside it -- it runs in
 * the page, not in the extension, and closes over nothing.
 *
 * Styling is inline and explicit rather than token-based: this is a foreign
 * page, the design system does not exist here, and inheriting the site's CSS
 * is exactly what must not happen.
 */
function regionPicker(frozenDataUrl) {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;cursor:crosshair";
    // A closed shadow root: the page cannot style it, and our styles cannot
    // leak into the page we are about to photograph again.
    const root = host.attachShadow({ mode: "closed" });

    root.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap { position: fixed; inset: 0; cursor: crosshair; user-select: none; }
        .shot { position: absolute; inset: 0; width: 100%; height: 100%;
                object-fit: fill; -webkit-user-drag: none; }
        .dim  { position: absolute; inset: 0; background: rgba(0,0,0,.45); }
        .sel  { position: absolute; border: 1px solid #fff;
                box-shadow: 0 0 0 9999px rgba(0,0,0,.45); display: none; }
        .size { position: absolute; transform: translateY(-22px);
                font: 12px/1.4 -apple-system, "Segoe UI", sans-serif;
                background: #111; color: #fff; padding: 1px 6px; border-radius: 3px;
                white-space: nowrap; }
        .tip  { position: fixed; left: 50%; top: 18px; transform: translateX(-50%);
                font: 13px/1.5 -apple-system, "Segoe UI", sans-serif;
                background: rgba(17,17,17,.92); color: #fff;
                padding: 7px 14px; border-radius: 6px; white-space: nowrap; }
      </style>
      <div class="wrap">
        <img class="shot" src="${frozenDataUrl}" alt="">
        <div class="dim"></div>
        <div class="sel"><div class="size"></div></div>
        <div class="tip">Prevuci preko dela koji treba da se vidi &nbsp;·&nbsp; Esc otkazuje</div>
      </div>`;

    document.documentElement.append(host);

    const sel = root.querySelector(".sel");
    const dim = root.querySelector(".dim");
    const size = root.querySelector(".size");
    const tip = root.querySelector(".tip");
    let start = null;

    const finish = (value) => {
      window.removeEventListener("keydown", onKey, true);
      host.remove();
      resolve(value);
    };

    const onKey = (ev) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(null);
    };
    window.addEventListener("keydown", onKey, true);

    const wrap = root.querySelector(".wrap");

    wrap.addEventListener("pointerdown", (ev) => {
      start = { x: ev.clientX, y: ev.clientY };
      dim.style.display = "none";     // the selection box paints its own dimming
      sel.style.display = "block";
      tip.style.display = "none";
      wrap.setPointerCapture(ev.pointerId);
    });

    wrap.addEventListener("pointermove", (ev) => {
      if (!start) return;
      const x = Math.min(start.x, ev.clientX);
      const y = Math.min(start.y, ev.clientY);
      const w = Math.abs(ev.clientX - start.x);
      const h = Math.abs(ev.clientY - start.y);
      sel.style.left = `${x}px`;
      sel.style.top = `${y}px`;
      sel.style.width = `${w}px`;
      sel.style.height = `${h}px`;
      size.textContent = `${Math.round(w)} × ${Math.round(h)}`;
    });

    wrap.addEventListener("pointerup", (ev) => {
      if (!start) return finish(null);
      const x = Math.min(start.x, ev.clientX);
      const y = Math.min(start.y, ev.clientY);
      const w = Math.abs(ev.clientX - start.x);
      const h = Math.abs(ev.clientY - start.y);
      finish({ x, y, w, h, viewportWidth: window.innerWidth });
    });
  });
}
