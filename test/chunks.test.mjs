// Pure-logic tests for the attachment chunker -- the one place where being
// silently wrong costs a customer their evidence rather than throwing.
//
//   node test/chunks.test.mjs
//
// No test runner on purpose: this must be runnable on a machine with nothing
// installed, the same reason the Python adapter refuses `requests`.

import { planChunks, attachmentCheck } from "../src/lib/helpdesk.js";
import { ATTACH_MAX_FILES, ATTACH_MAX_BYTES } from "../src/lib/constants.js";

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}\n         ocekivano: ${e}\n         dobijeno:  ${a}`);
  }
}

const MB = 1024 * 1024;
const f = (name, bytes) => ({ name, blob: { size: bytes, type: "image/png" } });
const shape = (chunks) => chunks.map((c) => c.map((x) => x.name));

console.log("attachmentCheck");
check("odbija nedozvoljen tip", attachmentCheck(f("snimak.mp4", 1000)).reason.includes("nije dozvoljen"), true);
check("odbija prazan fajl", attachmentCheck(f("a.png", 0)).reason.includes("prazan"), true);
check("odbija preko 5 MB", attachmentCheck(f("a.png", 6 * MB)).reason.includes("prevelik"), true);
check("prihvata tacno 5 MB", attachmentCheck(f("a.png", ATTACH_MAX_BYTES)).reason, "");
check("prihvata jpeg", attachmentCheck(f("a.jpeg", 1000)).reason, "");
check("prihvata pdf", attachmentCheck(f("a.pdf", 1000)).reason, "");

console.log("\nplanChunks — granica broja fajlova");
{
  const files = Array.from({ length: 13 }, (_, i) => f(`s${i + 1}.png`, 100 * 1024));
  const { chunks, rejected } = planChunks(files);
  // The VEZ#05513 case: 13 screenshots must become several comments, and all
  // 13 must still be delivered.
  check("13 malih slika -> 3 komentara", chunks.length, 3);
  check("nijedna nije odbijena", rejected.length, 0);
  check("nijedna nije izgubljena", chunks.flat().length, 13);
  check("nijedan komentar ne prelazi 5 fajlova",
    chunks.every((c) => c.length <= ATTACH_MAX_FILES), true);
}

console.log("\nplanChunks — granica velicine tela");
{
  // Four 2 MB files: the file count would allow one comment, the 5 MB byte
  // budget must not -- two fit (4 MB), the third would make it 6 MB.
  const { chunks } = planChunks([f("a.png", 2 * MB), f("b.png", 2 * MB), f("c.png", 2 * MB), f("d.png", 2 * MB)]);
  check("4 x 2 MB -> 2 komentara po dva", shape(chunks), [["a.png", "b.png"], ["c.png", "d.png"]]);
}
{
  const { chunks } = planChunks([f("a.png", 3 * MB), f("b.png", 3 * MB)]);
  check("2 x 3 MB se razdvaja", shape(chunks), [["a.png"], ["b.png"]]);
}
{
  const { chunks } = planChunks([f("a.png", 2 * MB), f("b.png", 2 * MB), f("c.png", 1 * MB)]);
  check("2+2+1 MB staje u jedan komentar", shape(chunks), [["a.png", "b.png", "c.png"]]);
}
{
  // The invariant that makes a lone max-size file deliverable at all.
  const { chunks } = planChunks([f("veliki.png", ATTACH_MAX_BYTES)]);
  check("jedan fajl od tacno 5 MB dobija svoj komentar", shape(chunks), [["veliki.png"]]);
}

console.log("\nplanChunks — odbijeni se prijavljuju, ne cute");
{
  const { chunks, rejected } = planChunks([
    f("ok1.png", 1000),
    f("snimak.webm", 1000),        // video: the helpdesk has no such type
    f("ogroman.png", 9 * MB),
    f("ok2.png", 1000),
  ]);
  check("dobri prolaze", shape(chunks), [["ok1.png", "ok2.png"]]);
  check("losi su prijavljeni", rejected.map((r) => r.file.name), ["snimak.webm", "ogroman.png"]);
}

console.log("\nplanChunks — degenerisani ulazi");
check("prazan ulaz", planChunks([]).chunks.length, 0);
check("null ulaz", planChunks(null).chunks.length, 0);

console.log(`\n${passed} proslo, ${failed} palo`);
process.exit(failed ? 1 : 0);
