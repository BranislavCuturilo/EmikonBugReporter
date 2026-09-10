// node --test. The tag is the only channel back to the brain, and the brain
// parses it with a Python port of parseTag -- so the round trip here is the
// contract both sides hold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTag, parseTag, appendTag, stripTag, editedFields, TAG_VERSION } from "../src/lib/tag.js";

const full = {
  withContext: ["audits:audit_detail"], withoutContext: ["locations:create"],
  role: "revizor", flags: ["escalations", "scoring"], skills: ["screen-list", "vez-tenant"],
  kind: "limitation", splitIndex: 2, splitTotal: 2, skipped: ["pitanja"],
  edited: ["title", "priority"],
};

test("build -> parse is lossless", () => {
  const tag = buildTag(full);
  assert.match(tag, /^\[ebr 0\.4 \| screens: audits:audit_detail✓ locations:create✗ \| role: revizor/);
  assert.match(tag, /\| skip: pitanja \| edited: title,priority\]$/);
  const back = parseTag(`Neki opis.\n\nKoraci...\n\n${tag}`);
  assert.deepEqual(back, { version: TAG_VERSION, ...full });
});

test("empty fields are dashes and parse back to empty", () => {
  const tag = buildTag({});
  assert.equal(tag, `[ebr ${TAG_VERSION} | screens: - | role: - | flags: - | skills: - | kind: - | skip: - | edited: -]`);
  const back = parseTag(tag);
  assert.deepEqual(back.withContext, []);
  assert.deepEqual(back.flags, []);
  assert.deepEqual(back.skipped, []);
  assert.equal(back.kind, "");
  assert.equal(back.splitTotal, 0);
});

test("a 0.3 tag still parses -- tickets already on the helpdesk must not go dark", () => {
  // Every ticket sent before the wizard existed carries this shape. It has no
  // `skip:` field at all, and that has to read as "nothing declared".
  const old = "[ebr 0.3 | screens: audits:audit_detail✓ | role: revizor | flags: - "
            + "| skills: screen-list | kind: bug | edited: title]";
  const back = parseTag(`Opis.\n\n${old}`);
  assert.equal(back.version, "0.3");
  assert.deepEqual(back.skipped, [], "absent means nothing was declined, not an error");
  assert.deepEqual(back.edited, ["title"], "and the rest of the tag is unaffected");
  assert.deepEqual(back.withContext, ["audits:audit_detail"]);
});

test("split is omitted for a single ticket and present for a decomposition", () => {
  assert.doesNotMatch(buildTag({ splitIndex: 1, splitTotal: 1 }), /split:/);
  assert.match(buildTag({ splitIndex: 1, splitTotal: 3 }), /split: 1\/3/);
});

test("appendTag replaces an old tag instead of stacking two", () => {
  const a = appendTag("Opis.", buildTag({ kind: "bug" }));
  const b = appendTag(a, buildTag({ kind: "limitation" }));
  assert.equal((b.match(/\[ebr /g) || []).length, 1);
  assert.match(b, /kind: limitation/);
  assert.equal(stripTag(b), "Opis.");
  assert.equal(appendTag("", buildTag({})), buildTag({}));
});

test("no tag -> null, and a bracket elsewhere in the text is not a tag", () => {
  assert.equal(parseTag("Opis [ebr nije tag] jos teksta"), null);
  assert.equal(parseTag(""), null);
});

test("editedFields: what the user changed, description compared without its tag", () => {
  const composed = { ticket_title: "A", ticket_description: "D", priority: "Minor", kind: "bug" };
  const sent = { ticket_title: "A!", ticket_description: appendTag("D", buildTag({})), priority: "Minor", kind: "limitation" };
  assert.deepEqual(
    editedFields(composed, sent, ["ticket_title", "ticket_description", "priority", "kind"]),
    ["title", "kind"]);
  assert.deepEqual(editedFields(composed, { ...composed }), []);
});
