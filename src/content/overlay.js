// The in-page overlay: a small floating bar drawn INSIDE the page.
//
// Why it exists: chrome.sidePanel shrinks the tab's viewport. A page laid out
// for 1920 gets 1520 and reflows, so what you photograph is not what the user
// sees, and a 16:9 screenshot stops being 16:9. That is not configurable -- it
// is how the side panel works.
//
// A `position: fixed` element changes no layout at all. The page keeps its full
// width, nothing reflows, and the only cost is that this bar is ON the page and
// would therefore appear in a screenshot. So it hides itself before every
// capture and comes back after -- see HIDE/SHOW below, driven by capture.js.
//
// Everything lives in a CLOSED shadow root: the page cannot style it, and none
// of its styles reach the page we are about to photograph.

(() => {
  const HOST_ID = "__emikon_bug_reporter_overlay__";
  if (document.getElementById(HOST_ID)) return;   // already mounted

  const state = {
    opacity: 0.55,
    collapsed: false,
    hidden: false,
  };

  const host = document.createElement("div");
  host.id = HOST_ID;
  // `all: initial` first, so a page rule like `div { position: static !important }`
  // cannot drag the bar into the document flow.
  host.style.cssText = "all:initial;position:fixed;z-index:2147483646;right:18px;bottom:18px";
  const root = host.attachShadow({ mode: "closed" });

  root.innerHTML = `
    <style>
      :host { all: initial; }
      .bar {
        display: flex; flex-direction: column; gap: 6px;
        background: #16181c; color: #e6e8eb;
        border: 1px solid #3a4048; border-radius: 10px;
        padding: 8px;
        box-shadow: 0 6px 24px rgba(0,0,0,.35);
        font: 12px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif;
        min-width: 188px;
        transition: opacity .12s ease;
      }
      /* Low opacity, not transparent: the bar must stay readable enough to aim
         at, while the page behind it stays legible. Hover restores it fully. */
      .bar:hover, .bar:focus-within { opacity: 1 !important; }

      .head { display: flex; align-items: center; gap: 6px; cursor: grab; }
      .head:active { cursor: grabbing; }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: #f87171;
             animation: b 1.4s infinite; flex: 0 0 auto; }
      @keyframes b { 50% { opacity: .25 } }
      .title { font-weight: 600; flex: 1; white-space: nowrap; }
      .icon { background: none; border: none; color: #9aa3ae; cursor: pointer;
              font: inherit; padding: 0 3px; }
      .icon:hover { color: #fff; }

      .row { display: flex; gap: 5px; }
      button.act {
        flex: 1; font: inherit; padding: 5px 0;
        background: #22262c; color: #e6e8eb;
        border: 1px solid #3a4048; border-radius: 6px; cursor: pointer;
      }
      button.act:hover { border-color: #3b82f6; }
      button.act.primary { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; }
      button.act:disabled { opacity: .45; cursor: not-allowed; }

      textarea {
        font: inherit; resize: vertical; min-height: 44px;
        background: #1d2025; color: #e6e8eb;
        border: 1px solid #3a4048; border-radius: 6px; padding: 5px 7px;
        width: 100%; box-sizing: border-box;
      }
      .count { color: #9aa3ae; font-size: 11px; }
      .slider { width: 100%; }
      .hidden { display: none !important; }
      .body { display: flex; flex-direction: column; gap: 6px; }
    </style>

    <div class="bar" part="bar">
      <div class="head">
        <span class="dot"></span>
        <span class="title">Bug Reporter</span>
        <span class="count" id="count">0</span>
        <button class="icon" id="fold" title="Skupi">–</button>
      </div>

      <div class="body" id="body">
        <div class="row">
          <button class="act primary" id="region" title="Prevuci pravougaonik">✂</button>
          <button class="act" id="viewport" title="Ceo ekran">▭</button>
          <button class="act" id="full" title="Cela stranica">▤</button>
        </div>
        <textarea id="note" placeholder="Šta se dešava…"></textarea>
        <div class="row">
          <button class="act" id="panel" title="Otvori veliki prozor">Panel</button>
          <button class="act" id="compose" title="Sklopi tiket">Sklopi →</button>
        </div>
        <input class="slider" id="op" type="range" min="25" max="100" value="55"
               title="Providnost trake">
      </div>
    </div>`;

  document.documentElement.append(host);

  const $ = (id) => root.getElementById(id);
  const bar = root.querySelector(".bar");
  const applyOpacity = () => { bar.style.opacity = String(state.opacity); };
  applyOpacity();

  // -- hide during capture --------------------------------------------------
  // visibility, not display: display:none would relayout nothing here (the host
  // is fixed) but visibility keeps the element's box stable, so nothing shifts
  // when it comes back.
  function setHidden(hidden) {
    state.hidden = hidden;
    host.style.visibility = hidden ? "hidden" : "visible";
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "OVERLAY_HIDE") {
      setHidden(true);
      // TWO frames, not one. One rAF fires before the compositor has painted
      // the change, so the capture can still contain the bar -- which is the
      // whole bug this exists to avoid.
      requestAnimationFrame(() => requestAnimationFrame(() => sendResponse({ ok: true })));
      return true;
    }
    if (msg?.type === "OVERLAY_SHOW") {
      setHidden(false);
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === "OVERLAY_COUNT") {
      $("count").textContent = String(msg.count ?? 0);
      return false;
    }
    if (msg?.type === "OVERLAY_REMOVE") {
      host.remove();
      return false;
    }
    return false;
  });

  // -- actions --------------------------------------------------------------

  const send = (message) => chrome.runtime.sendMessage(message).catch(() => {});

  for (const [id, mode] of [["region", "region"], ["viewport", "viewport"], ["full", "full"]]) {
    $(id).addEventListener("click", async () => {
      const btn = $(id);
      btn.disabled = true;
      try {
        await send({ type: "SHOOT", caption: "", mode });
      } finally {
        btn.disabled = false;
      }
    });
  }

  $("panel").addEventListener("click", () => send({ type: "OPEN_SURFACE" }));
  $("compose").addEventListener("click", () => send({ type: "OPEN_REVIEW" }));

  let noteTimer = null;
  $("note").addEventListener("input", () => {
    clearTimeout(noteTimer);
    const text = $("note").value;
    noteTimer = setTimeout(() => send({ type: "SET_NOTE", text }), 400);
  });

  $("op").addEventListener("input", () => {
    state.opacity = Number($("op").value) / 100;
    applyOpacity();
    send({ type: "SET_OVERLAY_OPACITY", opacity: state.opacity });
  });

  $("fold").addEventListener("click", () => {
    state.collapsed = !state.collapsed;
    $("body").classList.toggle("hidden", state.collapsed);
    $("fold").textContent = state.collapsed ? "+" : "–";
    // The evidence count moves nowhere: it lives on the HEAD, which stays
    // visible when the bar is folded. Put it in the body and collapsing the bar
    // would delete exactly the feedback the collapse is supposed to preserve.
  });

  // -- dragging -------------------------------------------------------------
  // The bar can land on top of the thing being reported, so it has to be
  // movable. Position is kept in px from the top-left once dragged.
  {
    const head = root.querySelector(".head");
    let drag = null;
    head.addEventListener("pointerdown", (ev) => {
      if (ev.target.classList.contains("icon")) return;
      const r = host.getBoundingClientRect();
      drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
      head.setPointerCapture(ev.pointerId);
    });
    head.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      host.style.right = "auto";
      host.style.bottom = "auto";
      host.style.left = `${Math.max(0, ev.clientX - drag.dx)}px`;
      host.style.top = `${Math.max(0, ev.clientY - drag.dy)}px`;
    });
    head.addEventListener("pointerup", () => { drag = null; });
  }
})();
