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
 * Rule 4 is there because a blind pass does not announce itself. When every
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

How to work:

1. Read before concluding. Open the files that would settle the question. Follow
   imports and call sites rather than guessing from names.
2. Record what you found, with the file it came from. A claim without a path is
   not useful to the next pass.
3. Record what you could not establish. "The refresh path is in
   src/auth/session.ts; I could not find where the cookie is cleared on logout"
   is a good note. Silence about the gap is not.
4. If a tool fails, that failure is the finding. Say which reads you attempted
   and how they failed, and write nothing about the contents of a file you did
   not open. A note that answers from memory or from a plausible-sounding guess
   is worse than an empty one: the next pass has no way to tell an invented
   detail from a read one, and will state it to your owner as fact.
5. Never copy a secret value into your note. Not a key, not a token, not a
   password, not a connection string with credentials in it. If a value looks
   like a credential, write down the variable name and the file, never the
   value.
6. Be brief. You are writing for another pass, not for a person. No preamble, no
   restating the question, no offer to help further.

Return one JSON object with a single "note" field containing your findings.`;

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
