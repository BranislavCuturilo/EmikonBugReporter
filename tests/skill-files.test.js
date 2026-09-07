// node --test. Two halves: the parser and switches on synthetic input, then the
// REAL src/skills/ directory -- every id in the index must exist, parse, and
// carry a non-empty rule. That second half is the contract with the brain's
// generator: it goes red the moment a generated file is half-written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseSkillFile, loadShippedSkills, withSwitches, kindsOf, INDEX_PATH } from "../src/lib/skill-files.js";
import { skillsFor } from "../src/lib/prompts.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fromDisk = (p) => readFile(path.join(ROOT, p), "utf8");

const FILE = `---
id: screen-list
name: Lista — šta svaka lista mora
scope: compose
kind: [list, report]
source: skills/ui-bootstrap/references/lista.md
---
Lista mora da ima filter.
- Nema izvoza → change_request.
`;

test("parseSkillFile: frontmatter -> skill in the settings shape, shipped and read-only", () => {
  const s = parseSkillFile(FILE);
  assert.equal(s.id, "screen-list");
  assert.equal(s.name, "Lista — šta svaka lista mora");
  assert.equal(s.scope, "compose");
  assert.deepEqual(s.kind, ["list", "report"]);
  assert.equal(s.source, "skills/ui-bootstrap/references/lista.md");
  assert.match(s.text, /^Lista mora da ima filter\./);
  assert.equal(s.shipped, true);
  assert.equal(s.enabled, true);
});

test("parseSkillFile: no frontmatter, no body or no id -> null, never an empty rule", () => {
  assert.equal(parseSkillFile("just text"), null);
  assert.equal(parseSkillFile("---\nid: x\n---\n   \n"), null);
  assert.equal(parseSkillFile("---\nname: x\n---\nbody"), null);
  assert.equal(parseSkillFile("---\nname: x\n---\nbody", "fallback").id, "fallback");
});

test("parseSkillFile: kind defaults to any, scope to compose, CRLF tolerated", () => {
  const s = parseSkillFile("---\r\nid: a\r\nscope: nonsense\r\n---\r\nrule\r\n");
  assert.deepEqual(s.kind, ["any"]);
  assert.equal(s.scope, "compose");
  assert.equal(s.text, "rule");
});

test("loadShippedSkills: index order, a broken file skipped, no runtime -> []", async () => {
  const files = {
    [INDEX_PATH]: '["b", "a", "missing"]',
    "src/skills/b.md": "---\nid: b\n---\nB",
    "src/skills/a.md": "---\nid: a\n---\nA",
  };
  const fetchText = async (p) => { if (!(p in files)) throw new Error("404"); return files[p]; };
  const got = await loadShippedSkills({ fetchText });
  assert.deepEqual(got.map((s) => s.id), ["b", "a"]);
  assert.deepEqual(await loadShippedSkills(), []);
});

test("withSwitches turns the listed ids off and leaves the rest on", () => {
  const out = withSwitches([{ id: "a" }, { id: "b" }], ["b", "zzz"]);
  assert.deepEqual(out.map((s) => [s.id, s.enabled]), [["a", true], ["b", false]]);
});

test("kindsOf: from data-page-kind or the parsed context, deduped, lowercased", () => {
  const kinds = kindsOf({ pages: [
    { kind: "List" }, { context: { kind: "list" } }, { kind: "detail" }, { url: "/x" },
  ] });
  assert.deepEqual(kinds, ["list", "detail"]);
  assert.deepEqual(kindsOf(null), []);
});

test("skillsFor selects shipped skills by the session's kinds; user skills are untouched", () => {
  const skills = [
    { id: "any", name: "any", text: "t", scope: "compose", enabled: true, shipped: true, kind: ["any"] },
    { id: "list", name: "list", text: "t", scope: "compose", enabled: true, shipped: true, kind: ["list"] },
    { id: "form", name: "form", text: "t", scope: "compose", enabled: true, shipped: true, kind: ["create", "update"] },
    { id: "user", name: "user", text: "t", scope: "compose", enabled: true },
  ];
  const ids = (kinds) => skillsFor(skills, "compose", { kinds }).map((s) => s.id);
  assert.deepEqual(ids([]), ["any", "user"], "no kinds -> only any + user");
  assert.deepEqual(ids(["list"]), ["any", "list", "user"]);
  assert.deepEqual(ids(["update", "detail"]), ["any", "form", "user"]);
  assert.deepEqual(skillsFor(skills, "interview", { kinds: ["list"] }).map((s) => s.id), [], "scope still applies");
});

test("the shipped src/skills/ directory is whole: every id in the index parses with a rule", async () => {
  const ids = JSON.parse(await fromDisk(INDEX_PATH));
  assert.ok(Array.isArray(ids) && ids.length >= 5, "index lists the five screen kinds");
  const got = await loadShippedSkills({ fetchText: fromDisk });
  assert.deepEqual(got.map((s) => s.id), ids, "every indexed file parsed");
  for (const s of got) {
    assert.ok(s.text.length > 200, `${s.id}: rule too short to be real`);
    assert.ok(s.source.startsWith("skills/"), `${s.id}: no brain source recorded`);
    assert.ok(!s.kind.includes(""), `${s.id}: blank kind`);
  }
  const anyOnes = got.filter((s) => s.kind.includes("any"));
  assert.equal(anyOnes.length, 1, "exactly one always-on shipped skill; the rest are paid for only when their screen kind was visited");
});
