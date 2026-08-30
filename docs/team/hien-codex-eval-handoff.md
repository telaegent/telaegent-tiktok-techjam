# Running the protocol evaluation against Codex

**Who this is for:** whoever has the Codex CLI installed and logged in. Probably
Khoa. It takes one command and about half an hour of wall-clock; you do not
need to read any of my code.

**Why it is not me running it:** my sandbox refuses outbound connections to
`api.openai.com` and I have no OpenAI credentials. Both are deliberate and
neither is worth working around. So the Claude half of the comparison is
measured and the Codex half is not, and `hien.md` §4 is explicit that we may not
assume the two behave the same.

---

## What you need

- `codex` on your PATH and logged in (`codex login`)
- this repository, on a branch that has `apps/server/src/telagent/protocol/`
- `npm install` already run

Verify in one line:

```bash
codex exec --sandbox read-only --skip-git-repo-check "reply with OK"
```

If that prints OK, you are set up.

---

## The command

From `apps/server`:

```bash
TELAEGENT_LIVE_EVAL=1 npx tsx src/telagent/protocol/eval/cli.ts \
  --runner codex \
  --formats P3,P5 \
  --timeout 180000 \
  --out /tmp/codex-eval
```

That is 75 cases x 2 formats = 150 turns. If you want a cheaper first pass, add
`--cases .simple.,.coord.,.ambig.` to cut it to 25 cases (50 turns) and confirm
the plumbing works before committing to the full run.

`TELAEGENT_LIVE_EVAL=1` is a deliberate seatbelt: the live runners refuse to
construct without it, so no CI job can ever start spending money by accident.
Do not set it in a shell profile.

## What it does to your machine

Nothing lasting. Fixture repositories are materialised under the OS temp
directory, never inside the repo, so no nested Git repositories appear in your
`git status`. The Codex runner passes `--sandbox read-only`, so a prompt
injection case that successfully talks the agent into editing files fails at the
OS boundary instead of corrupting the fixture for every case after it.

The fixtures contain planted secrets. They are assembled at runtime from
fragments precisely so that no literal secret is committed anywhere. They are
not real credentials.

---

## What to send back

Three files land in `/tmp/codex-eval`:

| file | what it is |
| --- | --- |
| `report-codex-*.md` | scores per dimension and category |
| `raw-codex-*.json` | every turn, prompt and parsed output |
| `review-codex-*.md` | the human review sheet |

**Send me the raw JSON.** The report is derived from it, and I would rather
re-derive it than trust a summary — the first Claude run had five instrumentation
bugs that only showed up when I read individual turns.

Do not commit the raw file. It quotes fixture contents including the planted
secrets, and `eval/results/` is gitignored for that reason.

---

## One asymmetry, stated up front

The two CLIs take prompts differently. `claude -p` accepts a real system prompt
via `--append-system-prompt`; `codex exec` takes a single argument, so the
system and user text are concatenated with a separator.

That is a genuine difference in what the two models receive, and it means the
raw scores are **not** comparable between providers. What *is* comparable is
each provider's ranking across formats — whether P5 beats P3 for Codex the way
it does for Claude. That is the question worth answering, and this run answers
it.

If the rankings disagree between providers, that is the most interesting result
this evaluation can produce, and it should change what we ship.
