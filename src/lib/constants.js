// Limits mirrored from the helpdesk serializer, via the proven Python adapter
// (brain/scripts/tickets/adapters/emikon_helpdesk.py). They are the SERVER's
// rules, so they bind us here too even though this extension talks to the API
// directly. A payload that breaks them is refused BEFORE it costs a round trip
// -- and, more importantly, before half a report exists on a live ticket.
//
// 2026-08-21, VEZ#05513: 13 approved screenshots were posted as one comment,
// the server refused the whole body, and the customer received nothing. That is
// why an over-cap set is SPLIT across comments here, never trimmed.
export const ATTACH_MAX_FILES = 5;
export const ATTACH_MAX_BYTES = 5 * 1024 * 1024;      // per FILE, server's cap
export const ATTACH_MAX_REQUEST_BYTES = ATTACH_MAX_BYTES; // per BODY, ours

// Ours, not the server's: the serializer caps each file at 5 MB and declares no
// total, so five of them is a 25 MB request no proxy in front of the helpdesk is
// known to accept. Chunking costs a comment; a rejected body costs the report.
// Never set below ATTACH_MAX_BYTES -- a lone file within the per-file cap must
// always fit in a comment of its own, or it could never be delivered at all.

export const ATTACH_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
};

// Video is deliberately absent above: the helpdesk accepts no video type at all.
// A recording is kept locally and reaches a ticket as extracted PNG key frames
// (see lib/recorder.js), never as the .webm itself.

export const API_PREFIX = "/api/v1";
export const TICKET_WEB_PATH = "/tickets/{id}";
export const TIMEOUT_MS = 30000;

// The helpdesk's OWN values, verbatim from ticket/models.py:41 --
// choices=(('Critical','Critical'),('Major','Major'),('Minor','Minor'),
// ('Trivial','Trivial')), default='Minor'. Capitalised, value == label.
//
// Sending "high" or "medium" is NOT an error the user would ever see: the field
// does not take it and the ticket quietly lands on the default. So never invent
// a friendlier scale here -- this list is a mirror, not a design decision.
// ticket/models.py:35 -- ticket_title is CharField(max_length=50). Django
// truncates nothing: an over-long title is a validation error, and a model
// generating titles has no idea this limit exists unless it is told.
export const TITLE_MAX = 50;

export const PRIORITIES = ["Critical", "Major", "Minor", "Trivial"];
export const PRIORITY_DEFAULT = "Minor";

/** What each level means here. One definition, used by the UI and by the
 *  instruction sent to the model, so the two can never drift apart. */
export const PRIORITY_HELP = {
  Critical: "blokira rad ili gubi podatke",
  Major: "ključna funkcija neupotrebljiva, postoji zaobilaznica",
  Minor: "smeta ali se radi",
  Trivial: "kozmetika",
};
