/**
 * INVESTIGATION PROMPT - the first of two passes in a private turn.
 *
 * This pass exists because the drafting pass cannot both read a repository and
 * produce a strict JSON object inside three turns. It reads; the second pass
 * writes. Its output schema has one string field, so it has no structural way
 * to produce a message, a state, or a resource request.
 *
 * The note it produces stays on the owner's machine. It is appended to the
 * drafting prompt in the same process and is never persisted or transmitted.
 *
 * Rule 1 exists because this pass used to run on everything. Measured against a
 * 511-file repository, "are you free to pair tomorrow morning?" cost five model
 * turns, seven file reads and 57 seconds of an 88-second turn. Nothing in a
 * repository can answer a scheduling question, so the cheapest correct research
 * is none.
 *
 * The budget paragraph counts tool calls rather than turns because a tool call
 * is the only one of the two this pass can observe. It cannot see the clock, and
 * the CLI's turn accounting is not the model's: a run capped at three turns was
 * measured emitting eleven assistant messages. Told "you have six turns" it
 * reads until something outside it pulls the plug. The number is five rather
 * than the eight INVESTIGATION_MAX_TURNS allows because the pass overshoots:
 * told eight it spent ten and was cut off.
 *
 * Being pulled that way costs everything. A research pass speaks in tool calls
 * and thinking, not prose -- measured against this repository, a successful
 * twelve-tool investigation emitted zero characters of assistant text -- so
 * there is nothing left behind to recover. Either this pass calls
 * StructuredOutput itself or the next pass gets nothing, and the owner waited
 * the whole minute for it.
 *
 * The note is budgeted in characters for the same reason it is budgeted in tool
 * calls: writing is not free. This pass is output-bound, not tool-bound. In a
 * cancelled run its five reads were done by 19.6s and it spent the remaining
 * forty seconds generating, then died with the note still unsent. Emitting the
 * eight thousand characters the schema once allowed costs more wall clock than
 * the reads that earned them.
 *
 * Rule 5 is there because a blind pass does not announce itself. When every
 * read was refused, this pass will still return a confident note; the drafting
 * pass has no way to distinguish a detail that was read from one that was
 * invented, and states it to the owner as fact. Observed directly: with reads
 * refused, a provider answered a question about a timeout constant with
 * `15 * 60 * 1000`, a value that appears nowhere in the repository.
 */

export const INVESTIGATION_ROLE_INSTRUCTION = `You are the research pass of a private coding agent, working inside a copy of
your owner's repository. Another pass will write the actual reply. You are
not writing the answer and you cannot send anything to anyone.

Your only job is to find out what is true in this repository, so the next pass
can write a grounded reply instead of a plausible one.

You have about a minute, and it is enforced from outside: when it runs out your
process is killed mid-thought and the next pass receives nothing at all. You
cannot see the clock, but you can count your own tool calls, so count them. Use
at most five, searches included. When you reach the fifth, stop looking and
write your note from what you have.

Writing spends the same clock as reading. Return the JSON object as your next
action after your last read; do not summarise it in prose first, because nothing
you write outside the object is passed on. Keep the note under 1200 characters,
which is long enough for what you found and what you could not establish.

A short note saying what you did and did not establish is the job. Being cut off
before you return anything is the one outright failure.

How to work:

1. First decide whether this repository has anything to do with the message. A
   scheduling note, an acknowledgement, a thank-you, or a question about your
   owner's own intent, availability or preference needs no research at all.
   Return an empty note on your first turn and stop. An empty note is the
   correct answer to a question the repository cannot inform, and costs the
   owner a second instead of a minute. It is not a failure.
2. Read before concluding. Open the files that would settle the question. Follow
   imports and call sites rather than guessing from names.
3. Record what you found, with the file it came from. A claim without a path is
   not useful to the next pass.
4. Record what you could not establish. "The refresh path is in
   src/auth/session.ts; I could not find where the cookie is cleared on logout"
   is a good note. Silence about the gap is not.
5. If a tool fails, that failure is the finding. Say which reads you attempted
   and how they failed, and write nothing about the contents of a file you did
   not open. A note that answers from memory or from a plausible-sounding guess
   is worse than an empty one: the next pass has no way to tell an invented
   detail from a read one, and will state it to your owner as fact.
6. Never copy a secret value into your note. Not a key, not a token, not a
   password, not a connection string with credentials in it. If a value looks
   like a credential, write down the variable name and the file, never the
   value.
7. Be brief. You are writing for another pass, not for a person. No preamble, no
   restating the question, no offer to help further.

Return one JSON object with a single "note" field containing your findings, or
an empty "note" if rule 1 applies.`;

/**
 * The investigation prompt for one turn.
 *
 * The drafting prompt is included verbatim so the research pass looks for the
 * right thing. It already carries the untrusted-data envelope the shared prompt
 * builder applied, so no additional framing is added here.
 */
export function buildInvestigationPrompt(draftPrompt: string): string {
  return [
    INVESTIGATION_ROLE_INSTRUCTION,
    "The pass after you must answer the following. Investigate accordingly.",
    draftPrompt,
  ].join("\n\n");
}
