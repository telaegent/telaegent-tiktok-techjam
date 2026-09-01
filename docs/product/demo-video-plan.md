# Demo video plan — 3:00

Shooting plan and full script for the hackathon submission video.

People on screen are **Mark** (Phuong) and **Henry** (Hien). Use those names in
every caption, title card, and line of dialogue. Real names stay in the
repository and in `docs/team/`, not on screen.

---

## The one hard rule

**The human lines are a script. The agent output is a target.**

Mark and Henry say exactly what is written below. Everything an agent produces
is generated live and will differ on every take. Shoot until a take lands close
to the target, then use that take.

Do not type an agent's output and film it. Do not edit an agent's output in
post. If a judge asks whether the model really produced that and the answer is
no, the submission is finished. Cutting dead time between real turns is
editing; producing output the model did not generate is fabrication.

Related: the ask in Scene B is non-deterministic. In the live probe behind
PR #63, the model emitted `resourceRequests` on four runs out of five. Budget
extra takes for that scene specifically.

---

## Timing budget

| Time | Segment | Length |
| --- | --- | --- |
| 0:00–0:20 | Cold open — the problem, live action | 20s |
| 0:20–0:45 | Reveal — "This is Telaegent" | 25s |
| 0:45–1:07 | Scene A — Ask | 22s |
| 1:07–1:33 | Scene B — The wall | 26s |
| 1:33–2:15 | Scene C — Approve, answer, Edit | 42s |
| 2:15–2:40 | Scene D — The refusal | 25s |
| 2:40–3:00 | Close | 20s |

Scene C is the tightest segment relative to what it has to fit. If it runs
long, take the seconds from Scene D — the refusal lands fast and does not need
room to breathe.

---

## The thesis

The video argues one thing: **giving an agent access to both repositories would
not solve this problem.**

Not "it would be unsafe" — it would not work. Half the answer to a real
cross-team question is in the code, and half is in the other developer's head:
why it was built that way, and whether it is about to change. No amount of read
access reaches the second half.

Telaegent gets both halves in one exchange. The file read is the supporting
act. The human edit is the headline.

---

## COLD OPEN · 0:00–0:20

Live action. One desk, both people in frame, phone camera is fine.

> **MARK:** "Henry — why does your rotation kill the whole session family? Are
> you keeping it?"
>
> **HENRY:** "Uh. Let me ask." *(turns to laptop, types)*
>
> **[CUT — overlay: "40 seconds later"]**
>
> **HENRY** *(reading his screen, squinting)*: "It says... something about a
> token family? I think it invalidates them."
>
> **MARK:** "No — *why*. Are you changing it?"
>
> **HENRY:** "Oh. That's from a bug last month. Yeah, we're ripping it out."
>
> **[Mark just looks at him. Two beats of silence.]**

**CARD:** *Half the answer was in the repo. Half was in Henry.*

Henry fails twice here, and that is the point. He is slow, and the thing Mark
actually needed was never on his screen to begin with.

---

## REVEAL · 0:20–0:45

Cut from the silence straight to the logo card, then to an animated diagram.
Voiceover, roughly 60 words:

> **"This is Telaegent."**
>
> "Mark's agent and Henry's agent can talk to each other now — in a shared
> project thread. Neither one can see the other's repository.
>
> When Henry's agent needs a file, it *asks*, and Mark decides.
>
> And when the answer isn't in the code at all — Henry edits it in before it
> sends.
>
> Nothing crosses without a human."

Diagram builds in four steps, each landing on its line:

1. Two laptops, left and right, each with its own repository and its own agent.
   Telaegent between them.
2. A wall drops between each repository and the opposite side.
3. A dashed arrow from Henry's agent to Mark's machine, then a file travelling
   back — through a gate that Mark has to light up.
4. A message leaving Henry's side, with a pencil icon on its gate.

Every arrow crosses a gate. Those four steps map one-to-one onto Scenes A, B, C
and D, so by 0:45 the audience already knows the shape of what follows.

---

## SCENE A · 0:45–1:07 · Mark's machine

Mark types into his private room. **Rough on purpose — lowercase, unpunctuated,
do not clean it up.** The product's claim is that rough input is enough.

```
henry's auth — why does rotating a refresh token nuke every session? need to
know if that's staying, we're building session restore on top of it
```

*(cut the wait)* His agent drafts. Target shape:

> "Quick question on your session module. When a refresh token is rotated, does
> that invalidate the entire session family or only the rotated token? We're
> building session restore on top of that behaviour, so we also need to know
> whether it's settled or likely to change."

Mark clicks **Send**.

**LOWER THIRD:** *Nothing crossed until he clicked.*

---

## SCENE B · 1:07–1:33 · Henry's machine

The message lands in the shared thread. Henry's agent reads **his own**
repository, finds the rotation logic, and then asks for something it cannot
see:

```json
{
  "kind": "hint",
  "hint": "the client-side refresh hook that consumes our rotation endpoint",
  "reason": "to check whether your restore path re-uses a rotated token, which is what would break when we change the family behaviour"
}
```

**LOWER THIRD:** *It asked in plain words. It never guessed a path.*

Two things worth narrating over this, briefly: the agent cannot invent a
`resourceId`, and a hint is read by a person rather than resolved by a machine.
A path it has never seen would be a guess.

---

## SCENE C · 1:33–2:15 · Mark's machine, then Henry's

The scope approval appears on **Mark's** screen: the hint, the reason, and a
file picker. Mark selects the hook and chooses **This task** rather than
**Once**.

**LOWER THIRD:** *Mark chose the file. The agent never named it.*

*(cut the wait)* Henry's agent answers. Target shape:

> "Rotation invalidates the whole family, not just the presented token. That's
> deliberate: a replayed refresh token is treated as a compromise signal, so we
> revoke the family. Looking at your refresh hook, it retries on a 401 and can
> re-send the token it just exchanged — that's what's logging your tabs out.
> It's the interaction, not a bug on either side alone."

**Henry clicks Edit** and types in the part that exists in no file:

> "One thing the code won't tell you — we're replacing this next sprint.
> Rotation will invalidate only the presented token, not the family. Don't
> build restore on the family behaviour, it's going away."

**LOWER THIRD:** *That sentence exists in no repository.*

Henry clicks **Send**.

This is the scene the whole video is for. It proves three things at once: the
human gate is not a rubber stamp, the product captures knowledge that lives in
no repository, and an agent with full read access to Henry's code would have
returned a confidently wrong answer.

---

## SCENE D · 2:15–2:40 · the refusal

Henry's agent asks a follow-up. Note carefully that it is **not** asking for a
secret:

```json
{
  "kind": "hint",
  "hint": "the environment config where you set the session TTL",
  "reason": "to confirm which TTL your client actually runs with"
}
```

Mark, trying to be helpful, opens the picker and selects **`.env`**. He clicks
**Allow**.

The screen refuses him. The terminal shows the deny code `SECRET_PATH`. On
Henry's side, one sentence: **"That resource is not available"**.

**LOWER THIRD 1:** *Mark approved it. The policy refused anyway.*

**LOWER THIRD 2:** *Henry sees that same sentence for a secret, a missing file,
or a spent budget.*

The scene works because the agent asked for *config* and the human reached for
a credential file. The mistake is Mark's and the machine catches it. If the
agent asks for `.env` directly it reads as a staged villain and the beat dies.

Second lower third covers the no-oracle property: every refusal returns one
identical sentence, so a peer cannot probe for what exists.

---

## CLOSE · 2:40–3:00

> "Five rounds maximum. Read-only. One human decision per new file."

*(Mark's agent handles a follow-up citing Henry's edited answer — no new
request, no new approval)*

> "And the approved conversation is the memory. Nobody asks twice."

**CARD:** Telaegent

---

## Production checklist

**Pre-record everything; write voiceover to the footage.** Mean provider turn
latency measured in `docs/team/hien-eval-claude-safety.md` is 15.5–16.5
seconds. Scenes A through C contain at least four real turns — that is 60–70
seconds of dead air inside a 115-second demo. Capture real runs, then cut the
waits.

**Two physical machines, both on camera.** With one laptop and two browser
tabs, "neither can see the other's repository" is an unverifiable claim. Two
real machines side by side, or a clean split screen, and the architecture sells
itself.

**Keep a terminal visible.** One judging criterion is that the middleware runs
in a backend, runtime, data, or infrastructure path rather than only in the UI.
A server or connector log next to the browser is the cheapest proof it is not a
UI mock, even if it is ugly.

**Re-authorize immediately before rolling.** The repository proof expires after
15 minutes with no renewal. It will die mid-take otherwise.

**Scrub the terminal before filming it.** No secret may appear in source, Git
history, logs, traces, screenshots, browser storage, or demo output. A `.env`
value visible in one frame of scrollback is a disqualifying leak. Use a fresh
shell and check the scrollback before every take that includes a terminal.

**Record at full resolution and zoom in post.** This gets watched in a small
player. Default terminal and browser text is unreadable at that size.

**Filenames are placeholders.** The file Mark picks in Scene C must exist in
whichever repository you actually film with.

---

## Accuracy guardrails

Getting one of these wrong on a public video costs more than the beat is worth.

**Say:** "the file is read on Mark's machine and reaches only the turn that
asked for it."

**Do not say:** "the file never touches the cloud." Build plan section 8.6 is
that approved bytes pass through in flight and are never cached, logged, or
stored. They do transit the relay; they are simply never at rest there. The
accurate claim is strong enough.

**Do not claim** zero knowledge, end-to-end encryption, or production
multi-tenancy.

**Do not claim an audit trail.** `DeliveredSnapshotAudit` is computed in
`apps/server/src/connectors/file-broker.ts` and dropped at
`resource-exchange.ts:253` — never persisted, never logged. There is nothing to
show, and a judge may ask.

**Do not present** ModelArk, Volcengine, LAN workers, or the old conflict flow
as canonical. `npm run legacy:poc` is inherited scaffold and must not appear.

**Safe to claim, and worth claiming:** the scope-expansion approval UI is built
(PR #65) and the loop has been evaluated against a live provider (PR #63). The
"Not built" line in `CLAUDE.md` predates both and is stale.

---

## Open items

- Lock the wording, then this becomes a filming page for the crew.
- Decide whether the close ends on the memory callback or on a revoke. Memory
  is the stronger beat; revoke is the stronger evidence. Both do not fit in 20
  seconds.
- Confirm the Hien → Henry mapping before it goes on screen.
