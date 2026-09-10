// node --test. The wizard decides ORDER, and the one thing it must never do is
// let a skip happen silently -- that was the defect it exists to fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wizardState, withSkip, modelTurns, SKIPPABLE } from "../src/lib/wizard.js";

const at = (s, id) => s.steps.find((x) => x.id === id);

test("a fresh session stops at the first thing that is missing", () => {
  const s = wizardState({});
  assert.equal(s.current, "dokazi");
  assert.equal(s.done, 0);
  assert.equal(at(s, "dokazi").state, "todo");
  assert.ok(at(s, "dokazi").why, "a todo step says what is missing");
});

test("console errors alone count as evidence -- a missing button has no screenshot", () => {
  assert.equal(wizardState({ errors: 1 }).current, "opis");
  assert.equal(wizardState({ evidence: 1 }).current, "opis");
});

test("nothing to send is not the same as everything sent", () => {
  // The trap: `sent >= drafts` is true for 0 >= 0, which would mark a session
  // with no ticket at all as finished.
  const s = wizardState({ evidence: 1, note: "x", ready: true, drafts: 0, sent: 0 });
  assert.equal(at(s, "slanje").state, "todo");
  assert.equal(s.current, "sklapanje");
});

test("the full happy path ends with every step done and no current step", () => {
  const s = wizardState({ evidence: 2, note: "ne mogu da obrišem", ready: true, drafts: 2, sent: 2 });
  assert.equal(s.current, "");
  assert.equal(s.done, s.total);
  assert.equal(s.skipsInterview, false);
  assert.equal(s.composeLabel, "Sklopi");
  assert.equal(s.composeNote, "");
});

test("the compose button NAMES the skip instead of hiding it", () => {
  const cold = wizardState({ evidence: 1, note: "x" });
  assert.equal(cold.skipsInterview, true);
  assert.equal(cold.composeLabel, "Preskoči pitanja i sklopi");
  assert.match(cold.composeNote, /nije postavio nijedno pitanje/);

  // Asked but unfinished is a different sentence: the AI did speak.
  const asked = wizardState({ evidence: 1, note: "x", modelTurns: 2 });
  assert.equal(asked.composeLabel, "Preskoči pitanja i sklopi");
  assert.match(asked.composeNote, /nije dobio dovoljno/);
});

test("no text in the wizard claims a cost we have not measured", () => {
  // Guard against the tempting "skipping makes tickets 3x slower" line. Nobody
  // has measured that yet; the skip is recorded precisely so it can be.
  for (const f of [{}, { evidence: 1, note: "x" }, { evidence: 1, note: "x", modelTurns: 3 }]) {
    const s = wizardState(f);
    const text = [s.composeNote, ...s.steps.map((x) => x.why)].join(" ");
    assert.doesNotMatch(text, /\d+\s*(x|puta|%)/i, `unmeasured number in: ${text}`);
  }
});

test("a declined step reads as skipped -- never as done", () => {
  const s = wizardState({ evidence: 1, note: "x", skipped: ["pitanja"] });
  assert.equal(at(s, "pitanja").state, "skipped");
  assert.notEqual(at(s, "pitanja").state, "done");
  assert.equal(s.done, 2, "skipped does not inflate the progress count");
  assert.equal(s.current, "sklapanje", "and the wizard moves on");
  assert.equal(s.skipsInterview, false, "already recorded, so nothing left to name");
  assert.equal(s.composeLabel, "Sklopi");
});

test("answering AFTER skipping still counts as done", () => {
  // Declining is not a lock. If the reporter changes their mind and the
  // interview then reports ready, the step is done, not skipped.
  const s = wizardState({ evidence: 1, note: "x", skipped: ["pitanja"], ready: true });
  assert.equal(at(s, "pitanja").state, "done");
});

test("withSkip records once, and only what may be declined", () => {
  assert.deepEqual(withSkip([], "pitanja"), ["pitanja"]);
  assert.deepEqual(withSkip(["pitanja"], "pitanja"), ["pitanja"], "double click writes one entry");
  assert.deepEqual(withSkip([], "dokazi"), [], "you cannot decline having no evidence");
  assert.deepEqual(withSkip(null, "pitanja"), ["pitanja"], "a session with no field yet");
  assert.deepEqual(withSkip([null, ""], "pitanja"), ["pitanja"], "junk is dropped, not carried into the tag");
  assert.ok(SKIPPABLE.has("pitanja") && !SKIPPABLE.has("sklapanje"));
});

test("modelTurns counts the AI, not the reporter", () => {
  assert.equal(modelTurns([{ role: "user", text: "a" }, { role: "model", text: "b" }]), 1);
  assert.equal(modelTurns([]), 0);
  assert.equal(modelTurns(null), 0);
  assert.equal(modelTurns([{ text: "no role" }]), 0);
});
