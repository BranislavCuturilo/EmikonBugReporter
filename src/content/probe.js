// Page probe. Answers the one question a screenshot cannot: WHO was looking at
// this, and in what window. Runs on every page; reports only while a session is
// recording (the worker drops the message otherwise).
//
// Identity detection is heuristic by necessity -- every app renders the signed-in
// user differently. The heuristics below cover the Emikon apps; anything else is
// handled by the CSS selector the user can set in Options, which always wins.

(() => {
  const MAX_LEN = 200;

  const clean = (v) => String(v == null ? "" : v).trim().replace(/\s+/g, " ").slice(0, MAX_LEN);

  const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

  /** Values a framework commonly parks on window. */
  function fromGlobals() {
    const out = {};
    const candidates = [
      window.currentUser, window.CURRENT_USER, window.__USER__,
      window.user, window.APP_USER,
    ];
    for (const c of candidates) {
      if (!c || typeof c !== "object") continue;
      out.user = out.user || clean(c.username || c.name || c.full_name || c.fullName);
      out.email = out.email || clean(c.email);
      if (out.user || out.email) break;
    }
    return out;
  }

  /** Meta tags and data attributes -- the server-rendered convention. */
  function fromMeta() {
    const out = {};
    const pick = (sel, attr) => {
      const el = document.querySelector(sel);
      return el ? clean(attr ? el.getAttribute(attr) : el.textContent) : "";
    };
    out.user =
      pick('meta[name="user"]', "content") ||
      pick('meta[name="username"]', "content") ||
      pick("[data-username]", "data-username") ||
      pick("[data-user]", "data-user");
    out.email =
      pick('meta[name="user-email"]', "content") ||
      pick("[data-user-email]", "data-user-email");
    return out;
  }

  /** The navbar. Last resort, and the noisiest -- so it only accepts a value
   *  that is short and does not read like a menu label. */
  function fromNavbar() {
    const sels = [
      ".navbar .dropdown-toggle",
      ".navbar-nav .nav-link.dropdown-toggle",
      "#userMenu",
      ".user-name",
      ".username",
    ];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const t = clean(el.textContent);
      if (t && t.length <= 60 && !/^(meni|menu|nalog|account|profil)$/i.test(t)) return { user: t };
    }
    return {};
  }

  function fromCustomSelector(selector) {
    if (!selector) return {};
    try {
      const el = document.querySelector(selector);
      if (!el) return {};
      const t = clean(el.textContent || el.value || el.getAttribute("content"));
      if (!t) return {};
      return looksLikeEmail(t) ? { email: t } : { user: t };
    } catch {
      return {}; // an invalid selector must not break the probe
    }
  }

  function detect(customSelector) {
    // Order is precedence: an explicit selector beats every guess.
    const merged = Object.assign({}, fromNavbar(), fromMeta(), fromGlobals(), fromCustomSelector(customSelector));
    const out = {};
    if (merged.user) out.user = merged.user;
    if (merged.email) out.email = merged.email;
    // A "user" that is actually an email belongs in the email field.
    if (out.user && !out.email && looksLikeEmail(out.user)) {
      out.email = out.user;
      delete out.user;
    }
    return out;
  }

  function env() {
    return {
      ua: navigator.userAgent,
      platform: navigator.platform,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      screen: `${screen.width}x${screen.height}`,
      dpr: window.devicePixelRatio,
      lang: navigator.language,
    };
  }

  function report() {
    chrome.storage.local.get("identitySelector", ({ identitySelector }) => {
      try {
        chrome.runtime.sendMessage({
          type: "PROBE",
          url: location.href,
          title: document.title,
          identity: detect(identitySelector),
          env: env(),
        });
      } catch {
        /* worker asleep or extension reloading -- the next navigation retries */
      }
    });
  }

  report();

  // SPAs change the page without a navigation event, and each such change is a
  // step the report needs. history.pushState is patched rather than polled.
  const fire = () => setTimeout(report, 300);
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function (...args) {
      const r = orig.apply(this, args);
      fire();
      return r;
    };
  }
  window.addEventListener("popstate", fire);
})();
