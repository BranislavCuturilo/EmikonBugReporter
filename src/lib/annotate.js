// Screenshot annotator: arrow, box, pixelate.
//
// Three tools, deliberately. A bug report needs "look here", "this region" and
// "this must not leave the building" -- everything else is drawing practice.
// Pixelate is not optional: screenshots of a live system carry customer names,
// OIBs and amounts, and a ticket is read by more people than the person who
// filed it.
//
// Renders into whatever page calls it (side panel or review window). Resolves
// with {blob, caption} on save, or null when cancelled.

const PIXELATE_BLOCK = 12;   // px of the source image per output block
const STROKE = "#ff2d55";    // annotation ink: one colour, always the same one,
                             // so a reader never wonders whether red means more
                             // urgent than orange
const LINE_W = 3;

export function openAnnotator(blob, caption = "") {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => mount(img, blob, caption, resolve);
    img.onerror = () => resolve(null);
    img.src = URL.createObjectURL(blob);
  });
}

function mount(img, srcBlob, caption, resolve) {
  const dlg = document.createElement("dialog");
  dlg.className = "annotator";
  dlg.innerHTML = `
    <style>
      dialog.annotator { border: none; padding: 0; max-width: 96vw; max-height: 96vh;
        background: var(--bg-raised); color: var(--text); border-radius: var(--radius); }
      dialog.annotator::backdrop { background: rgba(0,0,0,.8); }
      .an-wrap { display: flex; flex-direction: column; max-height: 96vh; }
      .an-tools { display: flex; gap: 6px; align-items: center; padding: 10px 12px;
        border-bottom: 1px solid var(--border); flex: 0 0 auto; flex-wrap: wrap; }
      .an-tools .sep { width: 1px; height: 22px; background: var(--border); }
      .an-canvas { flex: 1 1 auto; overflow: auto; padding: 12px; background: var(--bg-sunk); }
      .an-canvas canvas { display: block; margin: 0 auto; max-width: 100%; cursor: crosshair;
        box-shadow: 0 2px 14px rgba(0,0,0,.25); }
      .an-foot { display: flex; gap: 8px; align-items: center; padding: 10px 12px;
        border-top: 1px solid var(--border); background: var(--bg-raised); flex: 0 0 auto; }
      .an-foot input { flex: 1; }
      button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
    </style>
    <div class="an-wrap">
      <div class="an-tools">
        <button type="button" data-tool="arrow" class="sm on">↗ Strelica</button>
        <button type="button" data-tool="rect" class="sm">▭ Okvir</button>
        <button type="button" data-tool="blur" class="sm">▓ Zamuti</button>
        <span class="sep"></span>
        <button type="button" id="an-undo" class="sm">↶ Poništi</button>
        <span class="small muted" id="an-count">bez oznaka</span>
      </div>
      <div class="an-canvas"><canvas></canvas></div>
      <div class="an-foot">
        <input type="text" id="an-cap" placeholder="Opis ove slike — šta se na njoj vidi">
        <button type="button" id="an-cancel">Odustani</button>
        <button type="button" id="an-save" class="primary">Sačuvaj</button>
      </div>
    </div>`;
  document.body.append(dlg);

  const canvas = dlg.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;

  const marks = [];
  let tool = "arrow";
  let drag = null;

  const setCount = () => {
    dlg.querySelector("#an-count").textContent =
      marks.length ? `${marks.length} ${marks.length === 1 ? "oznaka" : "oznaka"}` : "bez oznaka";
  };

  function redraw(preview) {
    ctx.drawImage(img, 0, 0);
    for (const m of marks) paint(ctx, m);
    if (preview) paint(ctx, preview);
  }

  function paint(c, m) {
    c.save();
    c.strokeStyle = STROKE;
    c.fillStyle = STROKE;
    c.lineWidth = LINE_W;
    c.lineCap = "round";
    if (m.tool === "rect") {
      c.strokeRect(m.x0, m.y0, m.x1 - m.x0, m.y1 - m.y0);
    } else if (m.tool === "arrow") {
      drawArrow(c, m.x0, m.y0, m.x1, m.y1);
    } else if (m.tool === "blur") {
      pixelate(c, m);
    }
    c.restore();
  }

  function drawArrow(c, x0, y0, x1, y1) {
    const head = Math.max(10, LINE_W * 4);
    const a = Math.atan2(y1 - y0, x1 - x0);
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.stroke();
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x1 - head * Math.cos(a - Math.PI / 7), y1 - head * Math.sin(a - Math.PI / 7));
    c.lineTo(x1 - head * Math.cos(a + Math.PI / 7), y1 - head * Math.sin(a + Math.PI / 7));
    c.closePath();
    c.fill();
  }

  /** Downscale the region and blow it back up. Irreversible in the saved PNG,
   *  unlike a CSS filter -- the point is that the data is GONE, not hidden. */
  function pixelate(c, m) {
    const x = Math.min(m.x0, m.x1);
    const y = Math.min(m.y0, m.y1);
    const w = Math.abs(m.x1 - m.x0);
    const h = Math.abs(m.y1 - m.y0);
    if (w < 2 || h < 2) return;
    const sw = Math.max(1, Math.round(w / PIXELATE_BLOCK));
    const sh = Math.max(1, Math.round(h / PIXELATE_BLOCK));
    const tmp = document.createElement("canvas");
    tmp.width = sw;
    tmp.height = sh;
    const tctx = tmp.getContext("2d");
    tctx.drawImage(c.canvas, x, y, w, h, 0, 0, sw, sh);
    c.imageSmoothingEnabled = false;
    c.drawImage(tmp, 0, 0, sw, sh, x, y, w, h);
    c.imageSmoothingEnabled = true;
  }

  /** Screen px -> image px. The canvas is displayed scaled to fit, so raw
   *  offsetX would mark the wrong place on any image wider than the dialog. */
  function pos(ev) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - r.left) * (canvas.width / r.width),
      y: (ev.clientY - r.top) * (canvas.height / r.height),
    };
  }

  canvas.addEventListener("pointerdown", (ev) => {
    const p = pos(ev);
    drag = { tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const p = pos(ev);
    drag.x1 = p.x;
    drag.y1 = p.y;
    redraw(drag);
  });
  canvas.addEventListener("pointerup", () => {
    if (!drag) return;
    const moved = Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0) > 4;
    if (moved) marks.push(drag);
    drag = null;
    setCount();
    redraw();
  });

  for (const b of dlg.querySelectorAll("[data-tool]")) {
    b.addEventListener("click", () => {
      tool = b.dataset.tool;
      for (const o of dlg.querySelectorAll("[data-tool]")) o.classList.toggle("on", o === b);
    });
  }

  dlg.querySelector("#an-undo").addEventListener("click", () => {
    marks.pop();
    setCount();
    redraw();
  });

  const close = (value) => {
    URL.revokeObjectURL(img.src);
    dlg.close();
    dlg.remove();
    resolve(value);
  };

  dlg.querySelector("#an-cancel").addEventListener("click", () => close(null));

  dlg.querySelector("#an-save").addEventListener("click", () => {
    const cap = dlg.querySelector("#an-cap").value.trim();
    // No marks and no caption means nothing was actually done; return null so
    // the caller keeps the original rather than rewriting an identical file.
    if (!marks.length && cap === caption.trim()) return close(null);
    redraw();
    canvas.toBlob((out) => close(out ? { blob: out, caption: cap } : null), "image/png");
  });

  dlg.querySelector("#an-cap").value = caption;
  redraw();
  setCount();
  dlg.showModal();
}
