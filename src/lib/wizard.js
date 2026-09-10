// Which step the session is on, what is still missing, and what a skip costs.
//
// Everything the review page needs was already there before this file: the
// interview turn, its `ready` flag, the drafts, the send. What was missing is
// ORDER. "Ispitaj me" and "Sklopi" were two independent buttons, so a reporter
// could open the page and compose immediately -- no question asked, nothing
// recording that none was asked. Skipping the interview was not a decision,
// it was the shortest path.
//
// So: this module decides the step, and the page follows it. Two rules shape it.
//
// 1. NOTHING IS HARD-BLOCKED. A wizard that refuses to proceed is a wizard
//    people work around, and the reporter is often right -- some bugs need no
//    interview. What changes is that the button says what it is about to do:
//    "Preskoči pitanja i sklopi", never a bare "Sklopi".
//
// 2. A SKIP IS RECORDED. It rides the ticket tag to the brain (`skip:` in
//    tag.js), so `ebr_review.py` can eventually answer whether skipped
//    sessions cost more rounds on the helpdesk. Today nobody knows -- and the
//    UI must not pretend otherwise, which is why no text here claims a number
//    we have not measured.
//
// Pure: no DOM, no storage, no session object. The page maps its state onto
// the `facts` argument. That is what makes `tests/wizard.test.js` possible.

/** The steps, in order. `act` is the id of the control that advances it, or
 *  "" when nothing on the review page can (evidence is collected in the panel,
 *  before this screen exists). */
export const STEPS = [
  { id: "dokazi", label: "Dokazi", act: "" },
  { id: "opis", label: "Tvoj opis", act: "" },
  { id: "pitanja", label: "Pitanja", act: "interview" },
  { id: "sklapanje", label: "Predlog", act: "compose" },
  { id: "slanje", label: "Slanje", act: "sendAll" },
];

/** Steps a reporter may decline. Everything else is a fact about the session,
 *  not a choice -- you cannot "skip" having no screenshots. */
export const SKIPPABLE = new Set(["pitanja"]);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * @param {object} facts
 *   evidence   how many screenshots the session holds
 *   errors     how many console + network errors it caught
 *   note       what the reporter typed in the panel
 *   modelTurns how many times the AI has spoken in the chat
 *   ready      the interview's own verdict: it has enough
 *   skipped    step ids the reporter declined, e.g. ["pitanja"]
 *   drafts     how many tickets are composed
 *   sent       how many of those were delivered
 */
export function wizardState(facts = {}) {
  const evidence = num(facts.evidence);
  const errors = num(facts.errors);
  const note = String(facts.note || "").trim();
  const modelTurns = num(facts.modelTurns);
  const ready = Boolean(facts.ready);
  const skipped = new Set(Array.isArray(facts.skipped) ? facts.skipped : []);
  const drafts = num(facts.drafts);
  const sent = num(facts.sent);

  const done = {
    dokazi: evidence + errors > 0,
    opis: note.length > 0,
    pitanja: ready,
    sklapanje: drafts > 0,
    // `sent === 0` must not read as "all sent" when there is nothing to send.
    slanje: drafts > 0 && sent >= drafts,
  };

  const why = {
    dokazi: "Nema nijedne slike ni greške iz konzole.",
    opis: "Nisi napisao svojim rečima šta se desilo.",
    pitanja: modelTurns
      ? "AI još nema dovoljno — odgovori na pitanja."
      : "AI još nije pročitao dokaze.",
    sklapanje: "Predlog tiketa još nije sastavljen.",
    slanje: drafts ? `Poslato ${sent} od ${drafts}.` : "Nema šta da se pošalje.",
  };

  const steps = STEPS.map((s) => {
    // A declined step is never "current" again, but it is not "done" either --
    // the distinction is the whole point of recording it.
    const state = skipped.has(s.id) && !done[s.id]
      ? "skipped"
      : done[s.id] ? "done" : "todo";
    return { ...s, state, why: state === "done" ? "" : why[s.id] };
  });

  const pending = steps.find((s) => s.state === "todo");
  const current = pending ? pending.id : "";

  // Composing while the interview is unfinished is allowed -- and named.
  const skipsInterview = !done.pitanja && !skipped.has("pitanja");

  return {
    steps,
    current,
    done: steps.filter((s) => s.state === "done").length,
    total: steps.length,
    skipsInterview,
    composeLabel: skipsInterview ? "Preskoči pitanja i sklopi" : "Sklopi",
    // Said only when it is true, and it says what happened -- not what it costs.
    // We have never measured what it costs.
    composeNote: skipsInterview
      ? (modelTurns
          ? "AI je pitao, ali nije dobio dovoljno. Tiket ide sa onim što ima."
          : "AI nije postavio nijedno pitanje. Tiket ide na osnovu dokaza i tvog opisa.")
      : "",
  };
}

/** The reporter declined a step. Returns the new list, unchanged when the step
 *  is not one that may be declined or was already declined -- so a double click
 *  cannot write "pitanja,pitanja" into the tag. */
export function withSkip(skipped, stepId) {
  const cur = Array.isArray(skipped) ? skipped.filter(Boolean) : [];
  if (!SKIPPABLE.has(stepId) || cur.includes(stepId)) return cur;
  return [...cur, stepId];
}

/** Model turns in a stored chat. The chat is the interview's only record. */
export function modelTurns(chat) {
  return (Array.isArray(chat) ? chat : []).filter((m) => m?.role === "model").length;
}
