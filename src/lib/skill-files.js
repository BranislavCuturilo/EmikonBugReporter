// Skills that SHIP WITH the extension, as files under src/skills/.
//
// They are generated from the brain (scripts/brain/extension_skills.py) out of
// the same references the developers' agents read, so the rule a tester's
// ticket is judged by and the rule the screen was built by are one text. That
// is also why they are read-only here: an edit in the extension would be a
// second copy, and the brain's `--check` would flag it stale on the next run.
// The user can switch one off (settings.shippedOff); nothing else.
//
// A file is frontmatter + body:
//
//   ---
//   id: screen-list
//   name: Lista -- sta svaka lista mora
//   scope: compose
//   kind: [list]
//   source: skills/ui-bootstrap/references/lista.md
//   ---
//   <the rule, as an instruction to the model>
//
// `kind` is what makes them cheap: a skill applies only when the session
// visited a screen of that kind (data-page-kind), or when kind is "any". A
// session on two list screens pays for the list rules and nothing else.

import { ALWAYS_GROUP } from "./prompts.js";

export const INDEX_PATH = "src/skills/index.json";

/** `[a, b]` or `a, b` or `a` -> ["a", "b"]. Empty -> ["any"]. */
function listOf(v) {
  const s = String(v ?? "").trim().replace(/^\[|\]$/g, "");
  const out = s.split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  return out.length ? out : ["any"];
}

/**
 * One file -> one skill object in the same shape settings.skills uses, plus
 * `shipped: true` and `kind`. Returns null when the file has no frontmatter or
 * no body -- a half-file must not become a silent empty rule.
 */
export function parseSkillFile(text, fallbackId = "") {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text || ""));
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const body = m[2].trim();
  const id = meta.id || fallbackId;
  if (!id || !body) return null;
  const scope = ["both", "interview", "compose"].includes(meta.scope) ? meta.scope : "compose";
  return {
    id,
    name: meta.name || id,
    scope,
    kind: listOf(meta.kind),
    source: meta.source || "",
    text: body,
    enabled: true,
    shipped: true,
    groupId: ALWAYS_GROUP,
  };
}

/**
 * Every shipped skill, in index order. `fetchText(path)` reads one packaged
 * file; the default uses chrome.runtime, and where that does not exist (tests,
 * a page loaded outside the extension) the answer is simply [] -- shipped rules
 * are an addition, and their absence must not break a turn.
 */
export async function loadShippedSkills({ fetchText = defaultFetchText } = {}) {
  let ids;
  try {
    ids = JSON.parse(await fetchText(INDEX_PATH));
  } catch {
    return [];
  }
  if (!Array.isArray(ids)) return [];
  const out = [];
  for (const id of ids) {
    try {
      const s = parseSkillFile(await fetchText(`src/skills/${id}.md`), String(id));
      if (s) out.push(s);
    } catch {
      /* one missing file must not hide the others */
    }
  }
  return out;
}

async function defaultFetchText(path) {
  if (typeof chrome === "undefined" || !chrome.runtime?.getURL) throw new Error("no chrome.runtime");
  const r = await fetch(chrome.runtime.getURL(path));
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.text();
}

/** Apply the user's off-switches. `shippedOff` is a list of ids. */
export function withSwitches(shipped, shippedOff = []) {
  const off = new Set(shippedOff || []);
  return (shipped || []).map((s) => ({ ...s, enabled: !off.has(s.id) }));
}

/**
 * The kinds of screen a session touched, from the app's own data-page-kind.
 * Deduplicated; empty when no visited page declared one -- in which case only
 * "any" skills apply, which is the safe direction (no list rules for a session
 * that never saw a list).
 */
export function kindsOf(session) {
  const out = new Set();
  for (const p of session?.pages || []) {
    const k = p?.kind || p?.context?.kind;
    if (k) out.add(String(k).trim().toLowerCase());
  }
  return [...out];
}
