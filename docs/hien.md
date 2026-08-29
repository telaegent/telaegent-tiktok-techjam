# Hien — Tool Calls, Context Security, Phoenix Fixture, and End-to-End Tests

This file is your self-contained implementation brief. Read `plan.md` and `TELAGENT_PRODUCT_FLOW.md` completely before editing.

## 1. Mission

You own coworker workstream **#6** and the concrete security/evidence mechanisms behind it.

You will implement:

- the logical tool dispatcher
- source access grant/deny enforcement
- isolated approved-source workspaces
- ContextPack validation and redaction
- Phoenix repository fixture and safe Git evidence
- dependency-impact detection
- ownership diff verification
- deterministic fake runners and the full end-to-end integration scenario

You work as a pair with Duy. Duy defines tool schemas/permissions; you execute only valid, authorized calls.

## 2. Definition of success

Your work is done when:

- every logical tool has an executor or explicit human/server-only handling
- no model can approve itself or weaken a source policy
- `.env` and other forbidden paths are denied before open/copy
- traversal, absolute paths, secret names, unsupported glob syntax, and symlink escapes fail
- ContextPack generation sees only approved source files in a temporary workspace
- ContextPack sources are bound to trusted commit/hash metadata
- invalid, stale, oversized, uncited, unapproved, or secret-bearing packs are rejected
- Phoenix reliably creates separate Alice/Bob branches/workspaces and local tests
- Git diffs outside active ownership are rejected before checkpoint/completion
- Bob's contract change deterministically affects Alice
- one fake-runner Fastify test exercises the complete canonical flow
- safe cleanup and `npm run check` pass

## 3. Files you own

```text
apps/server/src/telagent/tool-dispatcher.ts
apps/server/src/telagent/context-policy.ts
apps/server/src/telagent/context-workspace.ts
apps/server/src/telagent/context-pack-validator.ts
apps/server/src/telagent/dependency-impact.ts
apps/server/src/telagent/redaction.ts
apps/server/src/telagent/git-helper.ts
apps/server/src/telagent/phoenix-fixture.ts
apps/server/src/telagent/context-policy.test.ts
apps/server/src/telagent/context-pack-validator.test.ts
apps/server/src/telagent/dependency-impact.test.ts
apps/server/src/telagent/redaction.test.ts
apps/server/src/telagent/integration.test.ts
```

You may add Phoenix fixture source files under the location agreed with Khoa.

Do not independently edit Duy's schemas, Phuong's runners, Khoa's service/store/routes, or Thai's frontend.

## 4. Day 0 freeze with Duy

Agree on:

- exact tool names/argument/result types
- permission-decision union
- path-rule grammar
- source reference fields
- ContextPack schema and size limits
- denial reason codes
- dependency change/impact/replan fields
- completion/Git evidence

No executor should accept `unknown` and cast without Zod validation.

## 5. Tool dispatcher

Input:

```ts
interface AuthorizedToolCall {
  callId: string;
  name: TelagentToolName;
  arguments: unknown;
  permissionDecision: PermissionDecision;
  actor: { ownerId: string; agentId: string };
  projectId: string;
  correlationId: string;
}
```

Rules:

- Re-parse arguments with Duy's tool schema.
- Reject calls whose permission is `deny` or still `ask_human`.
- Verify actor/project/current state through Khoa's supplied context.
- Return a small discriminated safe result.
- Never run arbitrary model-supplied command names.
- Never pass model strings to a shell.
- Never allow a tool call to grant its own permission.

Executors to support:

- publish intent/progress safe artifacts
- ask bounded status through Khoa/Phuong callback, not direct runner
- reply only to an existing pending request without expanding its scope, recipient, version, or expiry
- create proposal candidate safe artifact
- create context request
- create ContextPack from already-approved scope
- report dependency change
- return plan revision candidate
- provide completion evidence

Human-only and deterministic server-only actions are not model-callable dispatcher entries.

## 6. Context path policy

Supported rules only:

- exact file
- `directory/**` recursive prefix

Normalization order:

1. reject empty/NUL
2. replace `\` with `/`
3. reject drive/UNC/absolute path
4. remove benign leading `./`
5. normalize segments
6. reject any `..`
7. reject unsupported glob characters/patterns
8. apply always-deny names
9. join to canonical workspace root
10. resolve parent/target and reject escape or external symlink

Always-deny examples:

- `.env`, `.env.*`
- `.git/**`
- `*credential*`, `*secret*`, `*token*`
- private key/SSH/cloud credential conventions
- paths outside project
- private transcript/provider home/session files

The `.env` test must assert the filesystem read/copy helper was never called.

Limits from master plan:

- 5 rules
- 8 files
- 32 KiB/file
- 64 KiB total source
- 8 KiB final pack
- 15-minute TTL

## 7. Context workspace

Implement a helper with a lifecycle such as:

```ts
const isolated = await createApprovedContextWorkspace({
  sourceWorkspace,
  approvedRules,
  sourceCommit,
  limits
});

try {
  // Khoa asks Phuong to run an ephemeral read-only/no-network provider here.
} finally {
  await isolated.cleanup();
}
```

Requirements:

- create under an explicit safe temporary root
- copy only approved regular files
- preserve relative paths
- do not copy symlinks
- calculate byte size before/while copy
- SHA-256 each copied file
- create trusted manifest with relative path, commit, size, digest
- no `.git`, `.env`, or unapproved sibling files
- cleanup validates exact temporary target before recursive deletion
- no ContextPack data is appended to `AGENTS.md` or permanent provider memory

## 8. ContextPack validator

Validation sequence:

1. Request is approved, same project/task, current version, not expired.
2. Candidate parses Duy's schema.
3. At least one source.
4. Every source path exists in trusted manifest.
5. No candidate source outside approved rules.
6. Candidate task scope matches request.
7. Pack expiry does not exceed approval expiry.
8. Size limits pass.
9. Scan all textual fields for secret-like patterns.
10. Scan for obvious instruction/prompt injection indicators and reject suspicious packs rather than trusting them.
11. Replace candidate commit/hash metadata with trusted manifest values.
12. Return a new validated pack object; never mutate/persist raw candidate.

If redaction would destroy the meaning or source integrity, reject instead of partially delivering.

## 9. Redaction

Implement pure bounded helpers for:

- bearer/basic authorization headers
- common API key/token patterns
- PEM/private key blocks
- credential-like assignments
- sensitive absolute local paths
- raw provider error details

Return redacted value plus reason codes/count, never the original in logs.

Add tests proving secret values do not appear in serialized results, snapshots, or error messages.

## 10. Phoenix fixture

Create a small TypeScript fixture with:

```text
.telagent/project.json
.env
.gitignore
package.json
package-lock.json
tsconfig.json
docs/architecture/auth.md
src/auth/session.ts
src/auth/session-repository.ts
src/auth/fake-session-repository.ts
src/auth/redis-session-repository.ts
src/auth/oauth.ts
src/models/session.ts
src/models/user.ts
src/routes/login.ts
src/routes/oauth-callback.ts
tests/auth/session.test.ts
tests/auth/oauth.test.ts
```

Fixture rules:

- no external network/services
- dummy ignored `.env` exists only to prove denial
- fake Redis and OAuth interfaces
- initial `deviceId?` contract
- later Bob change makes `deviceId` required
- quick deterministic tests
- small enough for real Agents to understand in seconds

Initialization:

- copy base fixture to Alice/Bob workspace or create safe worktrees according to Starter Kit constraints
- preserve workspace `AGENTS.md`
- use Git `execFile` argument arrays
- local demo Git identity only
- base commit then feature branches
- run tests before returning success
- exact-target reset/cleanup only

## 11. Git helper

Pure/safe operations:

- current commit
- current branch
- status changed paths
- diff name-only from checkpoint
- create checkpoint commit
- validate changed paths against active ownership

Never:

- shell-concatenate branch/path/message
- run `reset --hard`
- delete broad roots
- push, merge, or modify remotes

Ownership validation:

- Alice may edit OAuth routes/provider/tests assigned by active agreement
- Bob may edit Session interface/repository/Redis implementation
- shared contract change is allowed only for Bob and must be published
- unexpected changes reject checkpoint with `OWNERSHIP_VIOLATION`

## 12. Dependency impact

Input:

- validated dependency change
- active intents
- active agreements/dependency links

Match normalized interface/API/schema names, with exact membership rather than fuzzy LLM judgment.

Demo expectation:

- change: `SessionRepository.create now requires deviceId`
- source: `src/auth/session-repository.ts`
- Alice intent depends on `Session`
- active agreement links Alice to Bob's Session contract
- result: Alice affected, unrelated intents not affected

Return safe evidence for Khoa to create a PlanRevision Operation.

## 13. Fake runners and full integration test

Create deterministic fake provider results keyed by purpose/stage, not by fragile prompt substring where avoidable.

The Fastify integration test must cover:

1. demo initialize
2. Bob intent/progress
3. Alice plan
4. deterministic blocking conflict
5. Bob status
6. proposal
7. separate approvals
8. Alice constrained implementation result
9. context request
10. Bob source approval
11. isolated pack validation/delivery
12. `.env` denial before read
13. Bob dependency change
14. Alice impact
15. plan revision
16. Alice approval/final implementation
17. completion/audit

Assertions:

- exact state transitions
- exact provider/sandbox/session mode calls
- raw prompt/output absent from store
- approval versions correct
- denied contents absent
- source manifest correct
- agreement ownership preserved
- audit sequence complete
- normal Agent endpoints remain functional

## 14. Tests you own

### Path/security

- exact and prefix rule success
- unsupported glob
- Unix/Windows absolute paths
- `..` variants and mixed separators
- `.env` variants
- `.git`
- secret-name variants
- symlink escape
- file/total count and size limits
- read helper never called on pre-denied path

### ContextPack

- valid pack
- no sources
- unapproved source
- stale commit/hash
- expired request/pack
- scope mismatch
- oversized output
- secret-bearing fields
- suspicious instruction-bearing source/candidate handling
- trusted metadata overwrite

### Git/dependency

- allowed Alice/Bob diffs
- ownership violation
- no-change completion behavior
- Session change affects Alice
- unrelated change does not

### Integration

- full flow and failure assertions
- `npm run check`

## 15. Daily deliverables

### Day 0

- tool/path/pack contracts frozen with Duy
- Phoenix file tree and test contract frozen

### Day 1

- fixture + Git helper
- tool dispatcher skeleton
- fake runners
- flow reaches deterministic conflict

### Day 2

- context policy/workspace/validator/redaction
- `.env` denial proof
- flow reaches delivered ContextPack

### Day 3

- dependency impact/ownership validation
- full 17-stage integration test
- real-run fixture support
- `npm run check`

### Day 4

- fresh-reset verification, README/diagram/demo evidence
- no new security mechanism unless fixing P0

## 16. Handoffs

To Duy:

- executor needs/schema gaps
- denial reason codes and edge cases
- paired test review

To Khoa:

- dispatcher/context/dependency function APIs
- fixture initialize/reset APIs
- full integration test hooks

To Phuong:

- isolated workspace path/manifest
- required read-only/network-none/ephemeral behavior
- changed-path result expectations

To Thai:

- sample permission, pack, denial, dependency, and completion payloads via Duy/Khoa

## 17. Do not do

- Do not expose arbitrary filesystem read/write tools.
- Do not trust model-provided source commit/hash.
- Do not follow symlinks into unapproved locations.
- Do not let a tool approve itself.
- Do not run ContextPack generation in Bob's full workspace.
- Do not copy `.git` or `.env` into temporary context.
- Do not use a general glob library/grammar.
- Do not store rejected candidate/source bodies.
- Do not auto-merge or push Git branches.
- Do not add real Redis/OAuth services.

## 18. Final report format

Require your coding agent to report:

1. files changed
2. final tool executors
3. exact path/ContextPack security guarantees
4. Phoenix/Git behavior
5. dependency/ownership behavior
6. integration test stages and result
7. `npm run check` result
8. unresolved contract issues by owner
