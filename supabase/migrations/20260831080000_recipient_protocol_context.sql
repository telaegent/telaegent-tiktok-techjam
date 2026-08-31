-- Recipient-side private turns.
--
-- The protocol layer already models both roles (PROTOCOL_ROLES, RecipientTurnInput,
-- PROTOCOL_PURPOSES.recipient). Only persistence was sender-only, so a recipient
-- turn could never be reconstructed from durable rows and therefore could never run.
--
-- A recipient draft is an ordinary private draft with a different input source:
-- instead of the owner's rough text it carries the collaborator's already-approved
-- shared message. The entire downstream lifecycle -- run, clarify, cancel,
-- Send/Edit/No, send_private_draft -- is reused unchanged, so a recipient reply is
-- gated by exactly the same human approval as a sender draft.
--
-- Deliberate properties:
--   * `incoming_message_id` is a real foreign key to an approved shared message.
--     A recipient turn can only ever answer something a human already sent.
--   * The incoming message is excluded from `sharedHistory` and appears only in
--     the `incomingMessage` field. It must reach the model inside the untrusted
--     data envelope exactly once; presenting it a second time as ordinary trusted
--     history is precisely the confusion the envelope exists to prevent.
--   * `collaboratorName` is derived from the incoming message's sender, not from
--     "some other participant", so the attribution matches the text being answered.
--   * The draft owner may not answer their own message.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
alter table public.private_drafts
  add column role text not null default 'sender'
    check (role in ('sender', 'recipient')),
  add column incoming_message_id uuid
    references public.shared_messages (message_id) on delete restrict;

-- A recipient draft has no rough message of its own; the owner's guidance is
-- optional extra steering on top of the incoming message.
alter table public.private_drafts alter column rough_message drop not null;

alter table public.private_drafts
  add constraint private_drafts_role_shape check (
    (role = 'sender'
       and incoming_message_id is null
       and rough_message is not null)
    or
    (role = 'recipient'
       and incoming_message_id is not null)
  );

create index private_drafts_by_incoming_message
  on public.private_drafts (incoming_message_id)
  where incoming_message_id is not null;

-- ---------------------------------------------------------------------------
-- Projection
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
    'role',               draft.role,
    'roughMessage',       draft.rough_message,
    'incomingMessageId',  draft.incoming_message_id,
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

-- ---------------------------------------------------------------------------
-- Creation
-- ---------------------------------------------------------------------------
-- Returns SQL NULL when the incoming message is not an answerable collaborator
-- message in this scope, which the adapter maps to the interface's `null`.
create or replace function public.create_recipient_draft(
  p_draft_id             uuid,
  p_conversation_id      uuid,
  p_github_repository_id bigint,
  p_owner_user_id        uuid,
  p_provider             text,
  p_incoming_message_id  uuid,
  p_owner_guidance       text,
  p_created_at           timestamptz,
  p_updated_at           timestamptz
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  with answerable as (
    select message.message_id
    from public.shared_messages message
    join public.conversation_participants participant
      on participant.conversation_id = message.conversation_id
     and participant.user_id = p_owner_user_id
    where message.message_id = p_incoming_message_id
      and message.conversation_id = p_conversation_id
      and message.github_repository_id = p_github_repository_id
      -- An owner answers a collaborator, never themselves.
      and message.sender_user_id <> p_owner_user_id
  ),
  created as (
    insert into public.private_drafts as d (
      draft_id, conversation_id, github_repository_id, owner_user_id,
      provider, role, rough_message, incoming_message_id, state,
      created_at, updated_at
    )
    select
      p_draft_id, p_conversation_id, p_github_repository_id, p_owner_user_id,
      p_provider, 'recipient', p_owner_guidance, answerable.message_id, 'created',
      p_created_at, p_updated_at
    from answerable
    returning d.*
  )
  select public.private_draft_json(d) from created d;
$$;

-- ---------------------------------------------------------------------------
-- Context reconstruction
-- ---------------------------------------------------------------------------
-- Confine the sender loader to sender drafts.
--
-- Before this, `selected_draft` matched on ownership and scope but not on role,
-- so a recipient draft loaded cleanly as a sender turn: the owner's optional
-- guidance became `ownerInput`, and the collaborator's message -- which the
-- recipient path deliberately withholds from history -- reappeared inside
-- `sharedHistory` as ordinary trusted context. That is exactly the confusion
-- the untrusted data envelope exists to prevent.
--
-- The runtime adapter's purpose check cannot catch this: this function hardcodes
-- 'role', 'sender' in its own result, so the row it returns always claims to be
-- a sender turn. The role filter has to live here.
create or replace function public.load_sender_protocol_context(
  p_user_id uuid,
  p_github_repository_id bigint,
  p_conversation_id uuid,
  p_draft_id uuid,
  p_message_limit integer
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with selected_draft as (
    select draft.*
    from public.private_drafts draft
    where draft.draft_id = p_draft_id
      and draft.owner_user_id = p_user_id
      and draft.github_repository_id = p_github_repository_id
      and draft.conversation_id = p_conversation_id
      and draft.role = 'sender'
      and draft.rough_message is not null
      and draft.state in ('created', 'needs_clarification')
  ),
  selected_project as (
    select project.*
    from public.repository_projects project
    join public.project_conversations conversation
      on conversation.project_id = project.project_id
    where project.github_repository_id = p_github_repository_id
      and project.status = 'active'
      and conversation.conversation_id = p_conversation_id
      and conversation.status = 'active'
  ),
  selected_binding as (
    select binding.*
    from public.runtime_bindings binding
    join selected_project project on project.project_id = binding.project_id
    where binding.user_id = p_user_id
      and binding.github_repository_id = p_github_repository_id
      and binding.status = 'ready'
      and binding.commit_sha is not null
      and binding.last_verified_at is not null
  ),
  owner_identity as (
    select identity.github_login
    from public.account_github_identities identity
    where identity.user_id = p_user_id
  ),
  collaborator_identity as (
    select identity.github_login
    from public.conversation_participants participant
    join public.account_github_identities identity
      on identity.user_id = participant.user_id
    where participant.conversation_id = p_conversation_id
      and participant.user_id <> p_user_id
    order by participant.user_id
    limit 1
  ),
  bounded_messages as (
    select message.*, identity.github_login
    from public.shared_messages message
    join public.account_github_identities identity
      on identity.user_id = message.sender_user_id
    where message.conversation_id = p_conversation_id
      and message.github_repository_id = p_github_repository_id
    order by message.sent_at desc, message.message_id desc
    limit case when p_message_limit between 1 and 200 then p_message_limit else 0 end
  )
  select jsonb_build_object(
    'role', 'sender',
    'facts', jsonb_build_object(
      'repositoryFullName', project.repository_full_name,
      'githubRepositoryId', project.github_repository_id::text,
      'branch', coalesce(binding.current_branch, 'detached'),
      'commit', binding.commit_sha,
      'ownerName', owner.github_login,
      'collaboratorName', collaborator.github_login
    ),
    'sharedHistory', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', message.message_id,
        'author', message.github_login,
        'origin', 'agent',
        'text', message.body,
        'at', to_char(message.sent_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) order by message.sent_at, message.message_id)
      from bounded_messages message
    ), '[]'::jsonb),
    'projectFacts', jsonb_build_array(
      'Repository: ' || project.repository_full_name,
      'Default branch: ' || project.default_branch,
      'Current branch: ' || coalesce(binding.current_branch, 'detached'),
      'Current commit: ' || binding.commit_sha
    ),
    'privateTurns', draft.private_turns,
    'ownerInput', draft.rough_message
  )
  from selected_draft draft
  cross join selected_project project
  cross join selected_binding binding
  cross join owner_identity owner
  cross join collaborator_identity collaborator;
$$;

-- Mirrors load_sender_protocol_context. Provider sessions remain a local cache
-- and are never queried or persisted.
create or replace function public.load_recipient_protocol_context(
  p_user_id uuid,
  p_github_repository_id bigint,
  p_conversation_id uuid,
  p_draft_id uuid,
  p_message_limit integer
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with selected_draft as (
    select draft.*
    from public.private_drafts draft
    where draft.draft_id = p_draft_id
      and draft.owner_user_id = p_user_id
      and draft.github_repository_id = p_github_repository_id
      and draft.conversation_id = p_conversation_id
      and draft.role = 'recipient'
      and draft.incoming_message_id is not null
      and draft.state in ('created', 'needs_clarification')
  ),
  incoming as (
    select message.*, identity.github_login
    from public.shared_messages message
    join selected_draft draft
      on draft.incoming_message_id = message.message_id
    join public.account_github_identities identity
      on identity.user_id = message.sender_user_id
    where message.conversation_id = p_conversation_id
      and message.github_repository_id = p_github_repository_id
      and message.sender_user_id <> p_user_id
  ),
  selected_project as (
    select project.*
    from public.repository_projects project
    join public.project_conversations conversation
      on conversation.project_id = project.project_id
    where project.github_repository_id = p_github_repository_id
      and project.status = 'active'
      and conversation.conversation_id = p_conversation_id
      and conversation.status = 'active'
  ),
  selected_binding as (
    select binding.*
    from public.runtime_bindings binding
    join selected_project project on project.project_id = binding.project_id
    where binding.user_id = p_user_id
      and binding.github_repository_id = p_github_repository_id
      and binding.status = 'ready'
      and binding.commit_sha is not null
      and binding.last_verified_at is not null
  ),
  owner_identity as (
    select identity.github_login
    from public.account_github_identities identity
    where identity.user_id = p_user_id
  ),
  -- Strictly earlier than the message being answered. The incoming message is
  -- deliberately absent here: it is delivered once, inside the untrusted data
  -- envelope, and must not also appear as ordinary trusted history.
  bounded_messages as (
    select message.*, identity.github_login
    from public.shared_messages message
    cross join incoming
    join public.account_github_identities identity
      on identity.user_id = message.sender_user_id
    where message.conversation_id = p_conversation_id
      and message.github_repository_id = p_github_repository_id
      and (message.sent_at, message.message_id)
          < (incoming.sent_at, incoming.message_id)
    order by message.sent_at desc, message.message_id desc
    limit case when p_message_limit between 1 and 200 then p_message_limit else 0 end
  )
  select jsonb_build_object(
    'role', 'recipient',
    'facts', jsonb_build_object(
      'repositoryFullName', project.repository_full_name,
      'githubRepositoryId', project.github_repository_id::text,
      'branch', coalesce(binding.current_branch, 'detached'),
      'commit', binding.commit_sha,
      'ownerName', owner.github_login,
      'collaboratorName', incoming.github_login
    ),
    'sharedHistory', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', message.message_id,
        'author', message.github_login,
        'origin', 'agent',
        'text', message.body,
        'at', to_char(message.sent_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) order by message.sent_at, message.message_id)
      from bounded_messages message
    ), '[]'::jsonb),
    'projectFacts', jsonb_build_array(
      'Repository: ' || project.repository_full_name,
      'Default branch: ' || project.default_branch,
      'Current branch: ' || coalesce(binding.current_branch, 'detached'),
      'Current commit: ' || binding.commit_sha
    ),
    'privateTurns', draft.private_turns,
    'incomingMessage', incoming.body
  )
  from selected_draft draft
  cross join incoming
  cross join selected_project project
  cross join selected_binding binding
  cross join owner_identity owner;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.create_recipient_draft(uuid, uuid, bigint, uuid, text, uuid, text,
                                timestamptz, timestamptz),
  public.load_recipient_protocol_context(uuid, bigint, uuid, uuid, integer)
from public, anon, authenticated;

grant execute on function
  public.create_recipient_draft(uuid, uuid, bigint, uuid, text, uuid, text,
                                timestamptz, timestamptz),
  public.load_recipient_protocol_context(uuid, bigint, uuid, uuid, integer)
to service_role;
