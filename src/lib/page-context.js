// Page and session context, as rendered by the app into its own HTML.
//
// A Django context processor (kontrola_vezuv: tenants/context_processors.py)
// writes two HTML comments right after <body>:
//
//   <!-- page-context audits:audit_detail
//   kind: detail | access: ... | requires: audit.view_all, audit.execute | feature: escalations
//   NE DOZVOLJAVA: otvaranje revizije van sopstvenog domena — ... (audit-2026-06-01)
//   Prikaz: Jedna revizija: zaglavlje, status, tim.
//   -->
//   <!-- session-context
//   role: revizor | permissions: audit.execute, audit.* | tenant: mns
//   features ON: escalations, scoring
//   features OFF that this page requires: -
//   -->
//
// plus data-page / data-page-kind / data-role / data-tenant on <body>. The
// content probe (an IIFE, no modules) only lifts the raw strings; this file
// turns them into structure and back into the text block the model reads.
// It is pure, so it is tested without a browser.

const first = (re, s) => { const m = re.exec(s || ""); return m ? m[1].trim() : ""; };
const list = (v) => String(v || "").split(",").map((x) => x.trim()).filter((x) => x && x !== "-");

/** The `page-context` comment -> structure. Returns null for an empty/foreign comment. */
export function parsePageComment(text) {
  const t = String(text || "").trim();
  if (!t.startsWith("page-context")) return null;
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  const urlName = (lines[0].split(/\s+/)[1] || "").trim();
  if (!urlName) return null;
  const head = lines[1] || "";
  const out = {
    url_name: urlName,
    kind: first(/kind:\s*([^|]+)/, head),
    access: first(/access:\s*([^|]+)/, head),
    requires: list(first(/requires:\s*([^|]+)/, head)),
    feature: first(/feature:\s*([^|]+)/, head),
    limits: [],
    summary: "",
  };
  for (const l of lines.slice(2)) {
    if (l.startsWith("NE DOZVOLJAVA:")) {
      const body = l.slice("NE DOZVOLJAVA:".length).trim();
      const since = first(/\(([^()]+)\)\s*$/, body);
      const noSince = since ? body.slice(0, body.lastIndexOf("(")).trim() : body;
      const [what, ...why] = noSince.split(" — ");
      out.limits.push({ what: what.trim(), why: why.join(" — ").trim(), since });
    } else if (l.startsWith("Prikaz:")) {
      out.summary = l.slice("Prikaz:".length).trim();
    }
  }
  return out;
}

/** The `session-context` comment -> structure. */
export function parseSessionComment(text) {
  const t = String(text || "").trim();
  if (!t.startsWith("session-context")) return null;
  const lines = t.split("\n").map((l) => l.trim());
  const head = lines[1] || "";
  const on = lines.find((l) => l.startsWith("features ON:")) || "";
  const off = lines.find((l) => l.startsWith("features OFF")) || "";
  return {
    role: first(/role:\s*([^|]+)/, head).replace(/^-$/, ""),
    permissions: list(first(/permissions:\s*([^|]+)/, head)),
    tenant: first(/tenant:\s*([^|]+)/, head).replace(/^-$/, ""),
    features_on: list(on.split(":").slice(1).join(":")),
    features_off_required: list(off.split(":").slice(1).join(":")),
  };
}

/**
 * The block the model reads, from the session's pages and identity.
 * One entry per screen (a page visited five times is one screen), pages that
 * carried NO context are named as such -- the model must be able to say "the
 * screen has no declaration" rather than guess, and that gap is what the tag
 * later reports back to the brain.
 */
export function contextBlock(session) {
  const s = session || {};
  const lines = [];

  const id = s.identity || {};
  if (id.role || (id.permissions || []).length || (id.features_on || []).length) {
    lines.push("=== SESIJA: KO, PRAVA, FLAGOVI ===");
    lines.push(
      `uloga ${id.role || "-"} · tenant ${id.tenant || "-"} · prava: ${(id.permissions || []).join(", ") || "-"}` +
      ` · flagovi ON: ${(id.features_on || []).join(", ") || "-"}`);
    if ((id.features_off_required || []).length) {
      lines.push(`flagovi OFF koje poseceni ekrani traze: ${id.features_off_required.join(", ")}`);
    }
    lines.push("Pravo `x.*` pokriva sve `x.<nesto>`; `*` pokriva sve. Ekran ciji `requires` " +
               "sesija ne pokriva, ili ciji je flag OFF, korisniku ne radi PO DIZAJNU.");
  }

  const seen = new Map();   // url_name -> context | null
  for (const p of s.pages || []) {
    const key = p?.context?.url_name || p?.pageId || "";
    if (!key) continue;
    if (!seen.has(key) || (p.context && !seen.get(key))) seen.set(key, p.context || null);
  }
  if (seen.size) {
    lines.push("\n=== KONTEKST EKRANA (jednom po ekranu) ===");
    for (const [key, c] of seen) {
      if (!c) { lines.push(`[${key}] — NEMA KONTEKST FAJL`); continue; }
      let head = `[${key} · ${c.kind || "?"}`;
      if (c.requires?.length) head += ` · trazi ${c.requires.join(", ")}`;
      if (c.feature) head += ` · flag ${c.feature}`;
      lines.push(head + "]");
      for (const l of c.limits || []) {
        lines.push(`  NE DOZVOLJAVA: ${l.what} — ${l.why}${l.since ? ` (${l.since})` : ""}`);
      }
      if (c.summary) lines.push(`  Prikaz: ${c.summary}`);
    }
  }
  return lines.join("\n");
}

/** url_names the session visited that carried a context, and those that did not. */
export function coverage(session) {
  const withCtx = new Set(), without = new Set();
  for (const p of session?.pages || []) {
    const key = p?.context?.url_name || p?.pageId || "";
    if (!key) continue;
    (p.context ? withCtx : without).add(key);
  }
  for (const k of withCtx) without.delete(k);
  return { withContext: [...withCtx], withoutContext: [...without] };
}
