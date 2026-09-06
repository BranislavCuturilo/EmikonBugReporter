// node --test. The schema is the contract between the model and review.js:
// a ticket without `kind` cannot be shown as "ogranicenje" and cannot be
// learned from, so the schema itself is pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPOSE_SCHEMA, INTERVIEW_SCHEMA, buildSystem } from "../src/lib/prompts.js";

test("compose schema: every ticket carries a kind from the closed set", () => {
  const item = COMPOSE_SCHEMA.properties.tickets.items;
  assert.deepEqual(item.properties.kind.enum, ["bug", "limitation", "question", "change_request"]);
  assert.ok(item.required.includes("kind"));
  assert.ok(item.properties.depends_on_context, "depends_on_context missing");
  assert.equal(COMPOSE_SCHEMA.properties.checks_suggested.items.required.join(","), "what,why");
  assert.equal(COMPOSE_SCHEMA.properties.context_missing.items.type, "string");
});

test("interview schema: suggestions ride alongside the questions", () => {
  assert.deepEqual(INTERVIEW_SCHEMA.properties.suggestions.items.required, ["what"]);
  assert.ok(!INTERVIEW_SCHEMA.required.includes("suggestions"), "suggestions must stay optional");
});

test("the compose instruction teaches the kind decision and the missing-context rule", () => {
  const sys = buildSystem("compose");
  for (const s of ["NE DOZVOLJAVA", "limitation", "question", "change_request",
                   "NEMA KONTEKST FAJL", "context_missing", "checks_suggested"]) {
    assert.ok(sys.includes(s), "compose system lacks: " + s);
  }
  const iv = buildSystem("interview");
  assert.ok(iv.includes("suggestions"), "interview system lacks suggestions");
  assert.ok(!iv.includes("checks_suggested"), "interview must not carry compose-only fields");
});
