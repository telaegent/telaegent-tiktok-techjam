-- Canonical conversation persistence: private drafts, human approvals, and
-- approved shared messages.
--
-- Mirrors apps/server/src/conversations/types.ts and the persistence contract
-- in apps/server/src/conversations/repository.ts. Every RPC corresponds to
-- exactly one ConversationRepository method and returns either the domain
-- record as JSON or SQL NULL, which the adapter maps to the interface's `null`.
--
-- Deliberate properties:
--   * The lifecycle state machine lives in the service. SQL enforces shape,
--     ownership and scope, and the transitions the interface documents as
--     guards, but it never decides product authorization.
--   * send_private_draft is one function, therefore one transaction: the
--     shared message, the approval record and the draft's sent state either
--     all commit or none do. That is the atomicity the repository requires.
--   * Idempotency is a UNIQUE constraint on (actor_user_id, idempotency_key),
--     not an application read-then-write, so concurrent duplicate sends cannot
--     both append a shared message.
--   * github_repository_id is a positive signed BIGINT returned as canonical
--     decimal text, matching the authorization schema.
--   * No table holds credentials, tokens, provider session references, raw
--     provider streams, or hidden model reasoning. `private_turns` holds only
--     owner-visible text, and drafts are never readable across users.

-- ---------------------------------------------------------------------------
-- Shared projection helper
-- ---------------------------------------------------------------------------
-- Matches the timestamp encoding used by the authorization snapshot RPC.
create or replace function public.iso_utc(value timestamptz)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select to_char(value at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.private_drafts (
  draft_id             uuid primary key,
  conversation_id      uuid not null
                         references public.project_conversations (conversation_id) on delete restrict,
  github_repository_id bigint not null check (github_repository_id > 0),
  owner_user_id        uuid not null
                         references public.user_accounts (user_id) on delete restrict,
  provider             text not null check (provider in ('codex', 'claude')),
  rough_message        text not null check (length(rough_message) between 1 and 2000),
  -- Owner-visible clarification transcript: [{ speaker, text }]. Bounded so a
  -- looping runtime cannot grow one row without limit.
  private_turns        jsonb not null default '[]'::jsonb
                         check (jsonb_typeof(private_turns) = 'array'
                                and jsonb_array_length(private_turns) <= 32),
  state                text not null check (state in (
                         'created', 'agent_working', 'needs_clarification', 'ready',
                         'blocked', 'runtime_failed', 'cancelled', 'sent')),
  turn_id              uuid,
  private_message      text check (private_message is null
                                   or length(private_message) between 1 and 2000),
  -- Holds the model candidate before approval and the exact human-approved
  -- body after it, so it follows the wider approved-content bound.
  send_candidate       text check (send_candidate is null
                                   or length(send_candidate) between 1 and 50000),
  risk_flags           jsonb not null default '[]'::jsonb
                         check (jsonb_typeof(risk_flags) = 'array'
                                and jsonb_array_length(risk_flags) <= 32),
  guard_findings       jsonb not null default '[]'::jsonb
                         check (jsonb_typeof(guard_findings) = 'array'
                                and jsonb_array_length(guard_findings) <= 32),
  failure              jsonb check (failure is null or jsonb_typeof(failure) = 'object'),
  created_at           timestamptz not null,
  updated_at           timestamptz not null,
  -- Set only by send_private_draft. Intentionally not a foreign key: the draft
  -- row is updated before the shared message is inserted inside one
  -- transaction, and the send RPC is the only writer of both.
  sent_message_id      uuid,
  constraint private_drafts_sent_message_state check (
    sent_message_id is null or state = 'sent'
  )
);

create index private_drafts_by_owner
  on public.private_drafts (owner_user_id, conversation_id);

create table public.shared_messages (
  message_id           uuid primary key,
  conversation_id      uuid not null
                         references public.project_conversations (conversation_id) on delete restrict,
  github_repository_id bigint not null check (github_repository_id > 0),
  sender_user_id       uuid not null
                         references public.user_accounts (user_id) on delete restrict,
  body                 text not null check (length(body) between 1 and 50000),
  -- Every shared message is produced by an agent and approved by its owner.
  origin               text not null check (origin = 'agent'),
  provider             text not null check (provider in ('codex', 'claude')),
  sent_at              timestamptz not null
);

-- Supports the conversation transcript read in its canonical order.
create index shared_messages_by_conversation
  on public.shared_messages (conversation_id, sent_at, message_id);

create table public.outbound_approvals (
  approval_id     uuid primary key,
  draft_id        uuid not null
                    references public.private_drafts (draft_id) on delete restrict,
  message_id      uuid not null
                    references public.shared_messages (message_id) on delete restrict,
  actor_user_id   uuid not null
                    references public.user_accounts (user_id) on delete restrict,
  approved_body   text not null check (length(approved_body) between 1 and 50000),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  approved_at     timestamptz not null,
  -- Exactly one recorded human approval per shared message.
  constraint outbound_approvals_one_per_message unique (message_id),
  -- The idempotency guarantee. Scoped to the actor so one user's key can never
  -- collide with, or replay, another user's approval.
  constraint outbound_approvals_owner_idempotency unique (actor_user_id, idempotency_key)
);

create index outbound_approvals_by_draft
  on public.outbound_approvals (draft_id);

-- ---------------------------------------------------------------------------
-- Row level security: enabled everywhere, no browser policies.
-- ---------------------------------------------------------------------------
-- Private drafts in particular must never be reachable by a browser role: a
-- draft is owner-private until its owner approves a send.
alter table public.private_drafts    enable row level security;
alter table public.shared_messages   enable row level security;
alter table public.outbound_approvals enable row level security;

revoke all on table
  public.private_drafts,
  public.shared_messages,
  public.outbound_approvals
from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Domain projections
-- ---------------------------------------------------------------------------
create or replace function public.private_draft_json(draft public.private_drafts)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'draftId',            draft.draft_id,
    'conversationId',     draft.conversation_id,
    'githubRepositoryId', draft.github_repository_id::text,
    'ownerUserId',        draft.owner_user_id,
    'provider',           draft.provider,
    'roughMessage',       draft.rough_message,
    'privateTurns',       draft.private_turns,
    'state',              draft.state,
    'turnId',             draft.turn_id,
    'privateMessage',     draft.private_message,
    'sendCandidate',      draft.send_candidate,
    'riskFlags',          draft.risk_flags,
    'guardFindings',      draft.guard_findings,
    'failure',            draft.failure,
    'createdAt',          public.iso_utc(draft.created_at),
    'updatedAt',          public.iso_utc(draft.updated_at),
    'sentMessageId',      draft.sent_message_id
  );
$$;

create or replace function public.shared_message_json(message public.shared_messages)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'messageId',          message.message_id,
    'conversationId',     message.conversation_id,
    'githubRepositoryId', message.github_repository_id::text,
    'senderUserId',       message.sender_user_id,
    'body',               message.body,
    'origin',             message.origin,
    'provider',           message.provider,
    'sentAt',             public.iso_utc(message.sent_at)
  );
$$;

create or replace function public.outbound_approval_json(approval public.outbound_approvals)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'approvalId',     approval.approval_id,
    'draftId',        approval.draft_id,
    'messageId',      approval.message_id,
    'actorUserId',    approval.actor_user_id,
    'approvedBody',   approval.approved_body,
    'idempotencyKey', approval.idempotency_key,
    'approvedAt',     public.iso_utc(approval.approved_at)
  );
$$;

-- ---------------------------------------------------------------------------
-- Lifecycle RPCs
-- ---------------------------------------------------------------------------
create or replace function public.create_private_draft(
  p_draft_id             uuid,
  p_conversation_id      uuid,
  p_github_repository_id bigint,
  p_owner_user_id        uuid,
  p_provider             text,
  p_rough_message        text,
  p_created_at           timestamptz,
  p_updated_at           timestamptz
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  insert into public.private_drafts as d (
    draft_id, conversation_id, github_repository_id, owner_user_id,
    provider, rough_message, state, created_at, updated_at
  )
  values (
    p_draft_id, p_conversation_id, p_github_repository_id, p_owner_user_id,
    p_provider, p_rough_message, 'created', p_created_at, p_updated_at
  )
  returning public.private_draft_json(d);
$$;

create or replace function public.get_private_draft(p_draft_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select public.private_draft_json(d)
  from public.private_drafts d
  where d.draft_id = p_draft_id;
$$;

-- Guard: owner-held and not yet started.
create or replace function public.mark_private_draft_running(
  p_draft_id      uuid,
  p_owner_user_id uuid,
  p_turn_id       uuid,
  p_updated_at    timestamptz
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  update public.private_drafts as d
  set state = 'agent_working',
      turn_id = p_turn_id,
      failure = null,
      updated_at = p_updated_at
  where d.draft_id = p_draft_id
    and d.owner_user_id = p_owner_user_id
    and d.state = 'created'
  returning public.private_draft_json(d);
$$;

-- Guard: the turn that is completing must still be the draft's current turn,
-- so a superseded or cancelled turn cannot overwrite newer state.
create or replace function public.complete_private_draft(
  p_draft_id         uuid,
  p_expected_turn_id uuid,
  p_state            text,
  p_private_message  text,
  p_send_candidate   text,
  p_risk_flags       jsonb,
  p_guard_findings   jsonb,
  p_updated_at       timestamptz
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  update public.private_drafts as d
  set state = p_state,
      private_message = p_private_message,
      send_candidate = p_send_candidate,
      risk_flags = p_risk_flags,
      guard_findings = p_guard_findings,
      failure = null,
      -- A clarification request becomes part of the owner-visible transcript.
      private_turns = case
        when p_state = 'needs_clarification'
          then d.private_turns || jsonb_build_array(
            jsonb_build_object('speaker', 'agent', 'text', p_private_message))
        else d.private_turns
      end,
      updated_at = p_updated_at
  where d.draft_id = p_draft_id
    and d.state = 'agent_working'
    and d.turn_id = p_expected_turn_id
    and p_state in ('needs_clarification', 'ready', 'blocked')
  returning public.private_draft_json(d);
$$;

-- Guard: owner-held and actually awaiting clarification. Returns the draft to
-- 'created' so the next run starts a fresh turn with the added context.
create or replace function public.add_private_draft_clarification(
  p_draft_id      uuid,
  p_owner_user_id uuid,
  p_content       text,
  p_updated_at    timestamptz
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  update public.private_drafts as d
  set private_turns = d.private_turns || jsonb_build_array(
        jsonb_build_object('speaker', 'owner', 'text', p_content)),
      state = 'created',
      turn_id = null,
      private_message = null,
      send_candidate = null,
      risk_flags = '[]'::jsonb,
      guard_findings = '[]'::jsonb,
      failure = null,
      updated_at = p_updated_at
  where d.draft_id = p_draft_id
    and d.owner_user_id = p_owner_user_id
    and d.state = 'needs_clarification'
  returning public.private_draft_json(d);
$$;

create or replace function public.mark_private_draft_failed(
  p_draft_id         uuid,
  p_expected_turn_id uuid,
  p_private_message  text,
  p_failure          jsonb,
  p_updated_at       timestamptz
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  update public.private_drafts as d
  set state = 'runtime_failed',
      private_message = p_private_message,
      failure = p_failure,
      send_candidate = null,
      updated_at = p_updated_at
  where d.draft_id = p_draft_id
    and d.state = 'agent_working'
    and d.turn_id = p_expected_turn_id
  returning public.private_draft_json(d);
$$;

-- Cancellation is idempotent for already-terminal drafts and, for a running
-- draft, requires the caller to name the turn it believes is running.
create or replace function public.cancel_private_draft(
  p_draft_id         uuid,
  p_owner_user_id    uuid,
  p_expected_turn_id uuid,
  p_updated_at       timestamptz
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_state text;
  v_result jsonb;
begin
  select d.state into v_state
  from public.private_drafts d
  where d.draft_id = p_draft_id
    and d.owner_user_id = p_owner_user_id;

  if not found then
    return null;
  end if;

  if v_state in ('sent', 'cancelled') then
    return public.get_private_draft(p_draft_id);
  end if;

  if v_state = 'agent_working'
     and (p_expected_turn_id is null
          or not exists (
            select 1 from public.private_drafts d
            where d.draft_id = p_draft_id and d.turn_id = p_expected_turn_id)) then
    return null;
  end if;

  update public.private_drafts as d
  set state = 'cancelled',
      send_candidate = null,
      updated_at = p_updated_at
  where d.draft_id = p_draft_id
    and d.owner_user_id = p_owner_user_id
  returning public.private_draft_json(d) into v_result;

  return v_result;
end;
$$;

-- The only writer of shared_messages. One function, therefore one transaction:
-- approval, shared message and draft state commit together or not at all.
create or replace function public.send_private_draft(
  p_draft_id             uuid,
  p_owner_user_id        uuid,
  p_approved_body        text,
  p_idempotency_key      text,
  p_message_id           uuid,
  p_conversation_id      uuid,
  p_github_repository_id bigint,
  p_provider             text,
  p_sent_at              timestamptz,
  p_approval_id          uuid,
  p_approved_at          timestamptz,
  p_updated_at           timestamptz
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_approval public.outbound_approvals;
  v_message  public.shared_messages;
  v_updated  boolean;
begin
  -- Replay: this owner already approved something under this key.
  select * into v_approval
  from public.outbound_approvals a
  where a.actor_user_id = p_owner_user_id
    and a.idempotency_key = p_idempotency_key;

  if found then
    -- A replay must describe the same approval. A reused key carrying
    -- different content is refused rather than resending, and must not
    -- disclose the earlier message.
    if v_approval.draft_id <> p_draft_id
       or v_approval.approved_body <> p_approved_body then
      return null;
    end if;

    select * into v_message
    from public.shared_messages m
    where m.message_id = v_approval.message_id;

    if not found then
      return null;
    end if;

    return jsonb_build_object(
      'message',  public.shared_message_json(v_message),
      'approval', public.outbound_approval_json(v_approval),
      'replayed', true
    );
  end if;

  -- First send. Guard: owner-held, reviewed, and carrying a candidate.
  update public.private_drafts as d
  set state = 'sent',
      send_candidate = p_approved_body,
      sent_message_id = p_message_id,
      updated_at = p_updated_at
  where d.draft_id = p_draft_id
    and d.owner_user_id = p_owner_user_id
    and d.state = 'ready'
    and d.send_candidate is not null;

  get diagnostics v_updated = row_count;
  if not v_updated then
    return null;
  end if;

  insert into public.shared_messages (
    message_id, conversation_id, github_repository_id, sender_user_id,
    body, origin, provider, sent_at)
  values (
    p_message_id, p_conversation_id, p_github_repository_id, p_owner_user_id,
    p_approved_body, 'agent', p_provider, p_sent_at)
  returning * into v_message;

  insert into public.outbound_approvals (
    approval_id, draft_id, message_id, actor_user_id,
    approved_body, idempotency_key, approved_at)
  values (
    p_approval_id, p_draft_id, p_message_id, p_owner_user_id,
    p_approved_body, p_idempotency_key, p_approved_at)
  returning * into v_approval;

  return jsonb_build_object(
    'message',  public.shared_message_json(v_message),
    'approval', public.outbound_approval_json(v_approval),
    'replayed', false
  );
end;
$$;

-- Approved shared messages only. Private drafts are never returned here.
create or replace function public.list_shared_messages(
  p_conversation_id uuid,
  p_limit           integer
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(payload order by sent_at, message_id), '[]'::jsonb)
  from (
    select m.sent_at, m.message_id, public.shared_message_json(m) as payload
    from public.shared_messages m
    where m.conversation_id = p_conversation_id
    order by m.sent_at, m.message_id
    limit p_limit
  ) as bounded;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: backend service role only.
-- ---------------------------------------------------------------------------
revoke all on function
  public.iso_utc(timestamptz),
  public.private_draft_json(public.private_drafts),
  public.shared_message_json(public.shared_messages),
  public.outbound_approval_json(public.outbound_approvals),
  public.create_private_draft(uuid, uuid, bigint, uuid, text, text, timestamptz, timestamptz),
  public.get_private_draft(uuid),
  public.mark_private_draft_running(uuid, uuid, uuid, timestamptz),
  public.complete_private_draft(uuid, uuid, text, text, text, jsonb, jsonb, timestamptz),
  public.add_private_draft_clarification(uuid, uuid, text, timestamptz),
  public.mark_private_draft_failed(uuid, uuid, text, jsonb, timestamptz),
  public.cancel_private_draft(uuid, uuid, uuid, timestamptz),
  public.send_private_draft(uuid, uuid, text, text, uuid, uuid, bigint, text,
                            timestamptz, uuid, timestamptz, timestamptz),
  public.list_shared_messages(uuid, integer)
from public, anon, authenticated;

-- The RPCs run as the caller, so the backend role also needs the projection
-- helpers they call. Without this, every RPC fails with a permission error the
-- moment it is reached by anything other than the database owner.
grant execute on function
  public.iso_utc(timestamptz),
  public.private_draft_json(public.private_drafts),
  public.shared_message_json(public.shared_messages),
  public.outbound_approval_json(public.outbound_approvals)
to service_role;

grant execute on function
  public.create_private_draft(uuid, uuid, bigint, uuid, text, text, timestamptz, timestamptz),
  public.get_private_draft(uuid),
  public.mark_private_draft_running(uuid, uuid, uuid, timestamptz),
  public.complete_private_draft(uuid, uuid, text, text, text, jsonb, jsonb, timestamptz),
  public.add_private_draft_clarification(uuid, uuid, text, timestamptz),
  public.mark_private_draft_failed(uuid, uuid, text, jsonb, timestamptz),
  public.cancel_private_draft(uuid, uuid, uuid, timestamptz),
  public.send_private_draft(uuid, uuid, text, text, uuid, uuid, bigint, text,
                            timestamptz, uuid, timestamptz, timestamptz),
  public.list_shared_messages(uuid, integer)
to service_role;
