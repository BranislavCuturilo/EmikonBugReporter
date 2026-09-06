// The trace tag: one bracketed line at the end of every ticket description.
//
//   [ebr 1.3 | screens: audits:audit_detail✓ locations:create✗ | role: revizor
//    | flags: escalations,scoring | skills: screen-list,vez-tenant | kind: limitation
//    | split: 2/2 | edited: title,priority]
//
// Why it exists. The helpdesk API accepts only ticket_description, so this is
// the ONLY channel through which "the extension was used, on these screens,
// with this context, and the user changed these fields before sending" can
// reach the brain. sync.py pulls the description into tickets_store; the brain
// parses this line back out and learns which screens generate tickets with no
// context file, which context was wrong (a `limitation` later fixed as a bug),
// and which fields the model keeps getting wrong (`edited:`).
//
// Pure. Parsed by the same regex on both sides so a format change is one edit.

export const TAG_VERSION = "0.3";
const OPEN = "[ebr ";

export function buildTag({
  version = TAG_VERSION, withContext = [], withoutContext = [], role = "",
  flags = [], skills = [], kind = "", splitIndex = 0, splitTotal = 0, edited = [],
} = {}) {
  const screens = [
    ...withContext.map((s) => `${s}✓`),
    ...withoutContext.map((s) => `${s}✗`),
  ].join(" ") || "-";
  const f = [
    `screens: ${screens}`,
    `role: ${role || "-"}`,
    `flags: ${flags.join(",") || "-"}`,
    `skills: ${skills.join(",") || "-"}`,
    `kind: ${kind || "-"}`,
  ];
  if (splitTotal > 1) f.push(`split: ${splitIndex}/${splitTotal}`);
  f.push(`edited: ${edited.join(",") || "-"}`);
  return `${OPEN}${version} | ${f.join(" | ")}]`;
}

/** Append the tag to a description, replacing any previous tag. */
export function appendTag(description, tag) {
  const body = stripTag(description).replace(/\s+$/, "");
  return body ? `${body}\n\n${tag}` : tag;
}

export function stripTag(description) {
  return String(description || "").replace(/\n*\[ebr [^\]]*\]\s*$/, "");
}

/** Read the tag back. Null when there is none. */
export function parseTag(description) {
  const m = /\[ebr ([^|\]]+)\|([^\]]*)\]\s*$/.exec(String(description || ""));
  if (!m) return null;
  const out = { version: m[1].trim(), withContext: [], withoutContext: [], role: "",
                flags: [], skills: [], kind: "", splitIndex: 0, splitTotal: 0, edited: [] };
  for (const raw of m[2].split("|")) {
    const [k, ...rest] = raw.split(":");
    const v = rest.join(":").trim();
    switch ((k || "").trim()) {
      case "screens":
        for (const s of v.split(/\s+/)) {
          if (!s || s === "-") continue;
          if (s.endsWith("✓")) out.withContext.push(s.slice(0, -1));
          else if (s.endsWith("✗")) out.withoutContext.push(s.slice(0, -1));
        }
        break;
      case "role": out.role = v === "-" ? "" : v; break;
      case "flags": out.flags = v === "-" ? [] : v.split(",").filter(Boolean); break;
      case "skills": out.skills = v === "-" ? [] : v.split(",").filter(Boolean); break;
      case "kind": out.kind = v === "-" ? "" : v; break;
      case "split": {
        const [i, n] = v.split("/").map(Number);
        out.splitIndex = i || 0; out.splitTotal = n || 0; break;
      }
      case "edited": out.edited = v === "-" ? [] : v.split(",").filter(Boolean); break;
      default: break;
    }
  }
  return out;
}

/** Which draft fields the user changed between compose and send. */
export function editedFields(composed, sent, fields = ["ticket_title", "ticket_description", "module", "category", "priority", "deadline"]) {
  const out = [];
  for (const f of fields) {
    const a = String(composed?.[f] ?? "").trim();
    const b = String(f === "ticket_description" ? stripTag(sent?.[f] ?? "") : (sent?.[f] ?? "")).trim();
    if (a !== b) out.push(f.replace(/^ticket_/, ""));
  }
  return out;
}
