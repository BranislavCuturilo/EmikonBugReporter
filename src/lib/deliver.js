// Delivering one drafted report to the helpdesk is NOT one call. It is:
//   1. create the ticket   (JSON only -- the endpoint carries no attachments)
//   2. post 1..N comments  (the evidence, split to fit the server's caps)
// Any step can fail after an earlier one succeeded, so this module treats the
// delivery as a resumable transaction with a written journal.
//
// The rule that shapes all of it: the comment endpoint has NO dedup key, so a
// blind retry double-posts. Therefore every step is CLAIMED in the journal
// before it is attempted, and a step whose outcome is unknown ("ambiguous")
// stops the run and asks a human -- it is never retried automatically.

import { planChunks, HelpdeskError } from "./helpdesk.js";

/** @typedef {{ticketId: string|null, sentChunks: number[], inFlight: number|null, done: boolean}} Journal */

export const emptyJournal = () => ({ ticketId: null, sentChunks: [], inFlight: null, done: false });

/**
 * Deliver one ticket + its evidence, resuming from `journal` if a previous run
 * stopped halfway.
 *
 * @param hd        Helpdesk instance
 * @param draft     {ticket_title, ticket_description, module, category, priority, assign_to_me}
 * @param files     [{name, blob, caption}] -- evidence, already annotated
 * @param journal   previous state, or emptyJournal()
 * @param persist   async (journal) => void  -- MUST durably write before returning
 * @param onStep    (msg, level) => void     -- progress for the UI
 */
export async function deliverTicket({ hd, draft, files = [], journal, persist, onStep = () => {} }) {
  const j = journal && typeof journal === "object" ? { ...journal } : emptyJournal();
  const save = async () => { await persist({ ...j }); };

  // A step whose outcome is unknown poisons the whole delivery. Refuse to
  // continue on top of it -- a human must look at the ticket first.
  if (j.inFlight !== null) {
    throw new HelpdeskError(
      `Prethodna isporuka je stala na komentaru #${j.inFlight + 1} i ishod je NEPOZNAT. ` +
      `Otvori tiket ${j.ticketId || "(nepoznat)"} na helpdesk-u, proveri da li je komentar prosao, ` +
      `pa oznaci korak rucno. Automatski retry bi mogao da duplira komentar.`,
      { ambiguous: true },
    );
  }

  // -- step 1: the ticket itself ------------------------------------------
  if (!j.ticketId) {
    onStep("Otvaram tiket...", "info");
    let created;
    try {
      created = await hd.createTicket(draft);
    } catch (e) {
      if (e instanceof HelpdeskError && e.ambiguous) {
        // The POST left the machine. A second attempt could open a DUPLICATE
        // ticket, which is worse than no ticket -- it reaches the customer.
        throw new HelpdeskError(
          "Zahtev za otvaranje tiketa je poslat ali odgovor nije stigao. " +
          "Proveri na helpdesk-u da li je tiket vec otvoren PRE nego sto pokusas ponovo.",
          { ambiguous: true },
        );
      }
      throw e;
    }
    j.ticketId = String(created?.ticket_id ?? created?.id ?? "").trim();
    if (!j.ticketId) throw new HelpdeskError("helpdesk je prihvatio tiket ali nije vratio id");
    await save();   // durable BEFORE any comment is attempted
    onStep(`Tiket otvoren: ${j.ticketId}`, "ok");
  }

  // -- step 2: the evidence ------------------------------------------------
  const { chunks, rejected } = planChunks(files);
  for (const r of rejected) onStep(`ODBIJEN prilog "${r.file?.name}": ${r.reason}`, "warn");

  for (let i = 0; i < chunks.length; i++) {
    if (j.sentChunks.includes(i)) continue;
    const chunk = chunks[i];
    const label = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : "";
    const body = buildCommentBody(chunk, label);

    j.inFlight = i;
    await save();                       // claim BEFORE sending
    try {
      await hd.addComment(j.ticketId, body, chunk);
    } catch (e) {
      if (e instanceof HelpdeskError && e.ambiguous) {
        // Leave inFlight set. The next run refuses to continue and says why.
        throw new HelpdeskError(
          `Komentar${label} je poslat ali odgovor nije stigao. Proveri tiket ${j.ticketId} ` +
          `na helpdesk-u pre ponovnog slanja -- retry bi duplirao komentar.`,
          { ambiguous: true },
        );
      }
      j.inFlight = null;                // a clean failure: safe to retry this one
      await save();
      throw e;
    }
    j.inFlight = null;
    j.sentChunks.push(i);
    await save();
    onStep(`Poslato ${chunk.length} priloga${label}`, "ok");
  }

  j.done = true;
  await save();
  return { ticketId: j.ticketId, url: hd.ticketUrl(j.ticketId), chunks: chunks.length, rejected };
}

/** Captions travel with the images -- an unlabelled screenshot is evidence
 *  nobody can act on three weeks later. */
function buildCommentBody(chunk, label) {
  const lines = [`Prilozi uz prijavu${label}:`];
  for (const f of chunk) {
    lines.push(`- ${f.name}${f.caption ? ` — ${f.caption}` : ""}`);
  }
  return lines.join("\n");
}
