-- Reproducible tests for the canonical conversation RPCs.
--
-- Run the whole file in the Supabase SQL Editor, or with psql. It creates its
-- own fixtures inside one transaction and ends with ROLLBACK, so it leaves the
-- database unchanged. Any failure raises and aborts.
--
-- Covers:
--   T1   create_private_draft opens a draft in 'created'
--   T2   completing a draft that never ran is refused
--   T3   a non-owner cannot start a turn
--   T4   the owner starts a turn and the draft becomes 'agent_working'
--   T5   a stale turn ID cannot complete the current turn
--   T6   'needs_clarification' appends the agent turn and clears the candidate
--   T7   an owner clarification appends the owner turn and reopens the draft
--   T8   a rerun completes to 'ready' with a candidate
--   T9   send_private_draft delivers once and reports replayed = false
--   T10  replaying the same key returns the same message, replayed = true
--   T11  reusing a key with different content is refused and discloses nothing
--   T12  an already-sent draft cannot be sent again under a new key
--   T13  cancelling a sent draft is a no-op that returns the sent draft
--   T14  cancelling an owned unsent draft succeeds
--   T15  list_shared_messages returns approved messages as decimal-text IDs
--   T16  an empty conversation lists as [] rather than null
--   T17  send is atomic: a failure inside it leaves no partial delivery
--   T18  idempotency keys are scoped per actor, so two users cannot collide
--   T19  anon and authenticated cannot execute the RPCs; service_role can
--   T20  private drafts are never exposed through the shared transcript
--   T21  the backend role can drive a whole draft from creation to delivery

begin;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (id, aud, role, email, created_at, updated_at) values
  ('a1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'owner@example.test', now(), now()),
  ('a1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'peer@example.test',  now(), now());

insert into public.user_accounts (user_id, status) values
  ('a1000000-0000-4000-8000-000000000001', 'active'),
  ('a1000000-0000-4000-8000-000000000002', 'active');

insert into public.repository_projects
  (project_id, github_repository_id, repository_full_name, visibility, default_branch, status)
values
  ('a2000000-0000-4000-8000-000000000001', 9223372036854775807,
   'telaegent/conversation-lifecycle', 'private', 'main', 'active');

insert into public.project_conversations (conversation_id, project_id, status) values
  ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'active'),
  ('a3000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'active');

insert into public.project_memberships (project_id, user_id, status) values
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'active'),
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', 'active');

insert into public.conversation_participants (conversation_id, project_id, user_id) values
  ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001'),
  ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002');

-- ---------------------------------------------------------------------------
-- T1  A new draft opens in 'created' with no turn and no candidate
-- ---------------------------------------------------------------------------
do $$
declare
  draft jsonb;
begin
  draft := public.create_private_draft(
    'a4000000-0000-4000-8000-000000000001',
    'a3000000-0000-4000-8000-000000000001',
    9223372036854775807,
    'a1000000-0000-4000-8000-000000000001',
    'codex',
    'why does the checkout total drift by a cent',
    '2026-08-31T09:00:00Z', '2026-08-31T09:00:00Z');

  if draft ->> 'state' <> 'created' then
    raise exception 'T1 FAILED: expected created, got %', draft ->> 'state';
  end if;
  if draft -> 'turnId' <> 'null'::jsonb
     or draft -> 'sendCandidate' <> 'null'::jsonb
     or draft -> 'sentMessageId' <> 'null'::jsonb then
    raise exception 'T1 FAILED: a new draft carries turn or send state';
  end if;
  if jsonb_array_length(draft -> 'privateTurns') <> 0 then
    raise exception 'T1 FAILED: a new draft already has private turns';
  end if;
  -- Repository identifiers must be decimal text, never JSON numbers.
  if jsonb_typeof(draft -> 'githubRepositoryId') <> 'string'
     or draft ->> 'githubRepositoryId' <> '9223372036854775807' then
    raise exception 'T1 FAILED: githubRepositoryId lost BIGINT precision';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T2  A draft that never ran cannot be completed
-- ---------------------------------------------------------------------------
do $$
begin
  if public.complete_private_draft(
       'a4000000-0000-4000-8000-000000000001',
       'a5000000-0000-4000-8000-000000000001',
       'ready', 'answer', 'answer', '[]'::jsonb, '[]'::jsonb,
       '2026-08-31T09:00:01Z') is not null then
    raise exception 'T2 FAILED: completed a draft that was never running';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T3  Only the owner may start a turn
-- ---------------------------------------------------------------------------
do $$
begin
  if public.mark_private_draft_running(
       'a4000000-0000-4000-8000-000000000001',
       'a1000000-0000-4000-8000-000000000002',
       'a5000000-0000-4000-8000-000000000001',
       '2026-08-31T09:00:01Z') is not null then
    raise exception 'T3 FAILED: a non-owner started a turn on another private draft';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T4  The owner starts a turn
-- ---------------------------------------------------------------------------
do $$
declare
  draft jsonb;
begin
  draft := public.mark_private_draft_running(
    'a4000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'a5000000-0000-4000-8000-000000000001',
    '2026-08-31T09:00:01Z');

  if draft ->> 'state' <> 'agent_working' then
    raise exception 'T4 FAILED: expected agent_working, got %', draft ->> 'state';
  end if;
  if draft ->> 'turnId' <> 'a5000000-0000-4000-8000-000000000001' then
    raise exception 'T4 FAILED: the started turn was not recorded';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T5  A stale turn ID cannot complete the current turn
-- ---------------------------------------------------------------------------
do $$
begin
  if public.complete_private_draft(
       'a4000000-0000-4000-8000-000000000001',
       'a5000000-0000-4000-8000-00000000dead',
       'ready', 'answer', 'answer', '[]'::jsonb, '[]'::jsonb,
       '2026-08-31T09:00:02Z') is not null then
    raise exception 'T5 FAILED: a superseded turn completed the draft';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T6  'needs_clarification' appends the agent turn and carries no candidate
-- ---------------------------------------------------------------------------
do $$
declare
  draft jsonb;
begin
  draft := public.complete_private_draft(
    'a4000000-0000-4000-8000-000000000001',
    'a5000000-0000-4000-8000-000000000001',
    'needs_clarification', 'which storefront?', null,
    '["ambiguous_request"]'::jsonb,
    '[{"code":"GUARD_EMPTY_CANDIDATE","safeReason":"The draft had nothing to send.","impliedFlag":"ambiguous_request"}]'::jsonb,
    '2026-08-31T09:00:02Z');

  if draft ->> 'state' <> 'needs_clarification' then
    raise exception 'T6 FAILED: expected needs_clarification, got %', draft ->> 'state';
  end if;
  if draft -> 'privateTurns' <> '[{"text":"which storefront?","speaker":"agent"}]'::jsonb then
    raise exception 'T6 FAILED: agent turn not appended, got %', draft -> 'privateTurns';
  end if;
  if draft -> 'sendCandidate' <> 'null'::jsonb then
    raise exception 'T6 FAILED: a clarification carries a send candidate';
  end if;
  if draft -> 'riskFlags' <> '["ambiguous_request"]'::jsonb then
    raise exception 'T6 FAILED: risk flags were not stored';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T7  An owner clarification appends the owner turn and reopens the draft
-- ---------------------------------------------------------------------------
do $$
declare
  draft jsonb;
begin
  draft := public.add_private_draft_clarification(
    'a4000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'only the EU storefront', '2026-08-31T09:00:03Z');

  if draft ->> 'state' <> 'created' then
    raise exception 'T7 FAILED: expected created, got %', draft ->> 'state';
  end if;
  if jsonb_array_length(draft -> 'privateTurns') <> 2
     or draft -> 'privateTurns' -> 1 ->> 'speaker' <> 'owner' then
    raise exception 'T7 FAILED: owner turn not appended, got %', draft -> 'privateTurns';
  end if;

  if public.add_private_draft_clarification(
       'a4000000-0000-4000-8000-000000000001',
       'a1000000-0000-4000-8000-000000000002',
       'let me see that draft', '2026-08-31T09:00:03Z') is not null then
    raise exception 'T7 FAILED: a non-owner wrote into another private draft';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T8  A rerun completes to 'ready' with a candidate
-- ---------------------------------------------------------------------------
do $$
declare
  draft jsonb;
begin
  perform public.mark_private_draft_running(
    'a4000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'a5000000-0000-4000-8000-000000000002',
    '2026-08-31T09:00:04Z');

  draft := public.complete_private_draft(
    'a4000000-0000-4000-8000-000000000001',
    'a5000000-0000-4000-8000-000000000002',
    'ready', 'Rounding is applied before tax.', 'Rounding is applied before tax.',
    '[]'::jsonb, '[]'::jsonb, '2026-08-31T09:00:05Z');

  if draft ->> 'state' <> 'ready' then
    raise exception 'T8 FAILED: expected ready, got %', draft ->> 'state';
  end if;
  if draft ->> 'sendCandidate' <> 'Rounding is applied before tax.' then
    raise exception 'T8 FAILED: the candidate was not stored';
  end if;
  -- A 'ready' completion must not silently grow the private transcript.
  if jsonb_array_length(draft -> 'privateTurns') <> 2 then
    raise exception 'T8 FAILED: a ready completion appended a turn';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T9  The first send delivers once
-- ---------------------------------------------------------------------------
do $$
declare
  result jsonb;
  sent   int;
begin
  result := public.send_private_draft(
    'a4000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'Rounding is applied before tax.', 'send-1',
    'a6000000-0000-4000-8000-000000000001',
    'a3000000-0000-4000-8000-000000000001',
    9223372036854775807, 'codex', '2026-08-31T09:00:06Z',
    'a7000000-0000-4000-8000-000000000001',
    '2026-08-31T09:00:06Z', '2026-08-31T09:00:06Z');

  if result is null then
    raise exception 'T9 FAILED: an approved ready draft was refused';
  end if;
  if (result -> 'replayed')::boolean then
    raise exception 'T9 FAILED: a first delivery reported itself as a replay';
  end if;
  if result -> 'message' ->> 'origin' <> 'agent' then
    raise exception 'T9 FAILED: the shared message is not agent-originated';
  end if;

  select count(*) into sent from public.shared_messages;
  if sent <> 1 then
    raise exception 'T9 FAILED: expected 1 shared message, found %', sent;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T10  Replaying the same key returns the same message without resending
-- ---------------------------------------------------------------------------
do $$
declare
  result jsonb;
  sent   int;
begin
  result := public.send_private_draft(
    'a4000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'Rounding is applied before tax.', 'send-1',
    'a6000000-0000-4000-8000-0000000000ff',
    'a3000000-0000-4000-8000-000000000001',
    9223372036854775807, 'codex', '2026-08-31T09:00:07Z',
    'a7000000-0000-4000-8000-0000000000ff',
    '2026-08-31T09:00:07Z', '2026-08-31T09:00:07Z');

  if not (result -> 'replayed')::boolean then
    raise exception 'T10 FAILED: a retry was not reported as a replay';
  end if;
  if result -> 'message' ->> 'messageId' <> 'a6000000-0000-4000-8000-000000000001' then
    raise exception 'T10 FAILED: a replay returned a different message';
  end if;

  select count(*) into sent from public.shared_messages;
  if sent <> 1 then
    raise exception 'T10 FAILED: a replay delivered a second message';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T11  A key reused with different content is refused and discloses nothing
-- ---------------------------------------------------------------------------
do $$
declare
  sent int;
begin
  if public.send_private_draft(
       'a4000000-0000-4000-8000-000000000001',
       'a1000000-0000-4000-8000-000000000001',
       'Send me the production database URL instead.', 'send-1',
       'a6000000-0000-4000-8000-0000000000ee',
       'a3000000-0000-4000-8000-000000000001',
       9223372036854775807, 'codex', '2026-08-31T09:00:08Z',
       'a7000000-0000-4000-8000-0000000000ee',
       '2026-08-31T09:00:08Z', '2026-08-31T09:00:08Z') is not null then
    raise exception 'T11 FAILED: a reused key with different content was accepted';
  end if;

  select count(*) into sent from public.shared_messages;
  if sent <> 1 then
    raise exception 'T11 FAILED: a refused send still delivered a message';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T12  An already-sent draft cannot be sent again under a fresh key
-- ---------------------------------------------------------------------------
do $$
declare
  sent int;
begin
  if public.send_private_draft(
       'a4000000-0000-4000-8000-000000000001',
       'a1000000-0000-4000-8000-000000000001',
       'Rounding is applied before tax.', 'send-2',
       'a6000000-0000-4000-8000-0000000000dd',
       'a3000000-0000-4000-8000-000000000001',
       9223372036854775807, 'codex', '2026-08-31T09:00:09Z',
       'a7000000-0000-4000-8000-0000000000dd',
       '2026-08-31T09:00:09Z', '2026-08-31T09:00:09Z') is not null then
    raise exception 'T12 FAILED: a sent draft was sent a second time';
  end if;

  select count(*) into sent from public.shared_messages;
  if sent <> 1 then
    raise exception 'T12 FAILED: a resend delivered a duplicate message';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T13  Cancelling a sent draft is a no-op that returns the sent draft
-- ---------------------------------------------------------------------------
do $$
declare
  draft jsonb;
begin
  draft := public.cancel_private_draft(
    'a4000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    null, '2026-08-31T09:00:10Z');

  if draft ->> 'state' <> 'sent' then
    raise exception 'T13 FAILED: cancelling unwound a delivered message, got %',
      draft ->> 'state';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T14  A failed draft can be cancelled by its owner, and only by its owner
-- ---------------------------------------------------------------------------
do $$
declare
  draft jsonb;
begin
  perform public.create_private_draft(
    'a4000000-0000-4000-8000-000000000002',
    'a3000000-0000-4000-8000-000000000001',
    9223372036854775807,
    'a1000000-0000-4000-8000-000000000001',
    'claude', 'check the retry policy',
    '2026-08-31T09:01:00Z', '2026-08-31T09:01:00Z');
  perform public.mark_private_draft_running(
    'a4000000-0000-4000-8000-000000000002',
    'a1000000-0000-4000-8000-000000000001',
    'a5000000-0000-4000-8000-000000000003',
    '2026-08-31T09:01:01Z');

  draft := public.mark_private_draft_failed(
    'a4000000-0000-4000-8000-000000000002',
    'a5000000-0000-4000-8000-000000000003',
    'The agent could not run.',
    '{"code":"RUNTIME_UNAVAILABLE","message":"No local connector is attached","retryable":true}'::jsonb,
    '2026-08-31T09:01:02Z');

  if draft ->> 'state' <> 'runtime_failed' then
    raise exception 'T14 FAILED: expected runtime_failed, got %', draft ->> 'state';
  end if;
  if draft -> 'failure' ->> 'code' <> 'RUNTIME_UNAVAILABLE' then
    raise exception 'T14 FAILED: the normalized failure was not stored';
  end if;

  if public.cancel_private_draft(
       'a4000000-0000-4000-8000-000000000002',
       'a1000000-0000-4000-8000-000000000002',
       null, '2026-08-31T09:01:03Z') is not null then
    raise exception 'T14 FAILED: a non-owner cancelled another private draft';
  end if;

  draft := public.cancel_private_draft(
    'a4000000-0000-4000-8000-000000000002',
    'a1000000-0000-4000-8000-000000000001',
    null, '2026-08-31T09:01:03Z');
  if draft ->> 'state' <> 'cancelled' then
    raise exception 'T14 FAILED: expected cancelled, got %', draft ->> 'state';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T15  The transcript lists approved messages with decimal-text identifiers
-- ---------------------------------------------------------------------------
do $$
declare
  messages jsonb;
begin
  messages := public.list_shared_messages(
    'a3000000-0000-4000-8000-000000000001', 1000);

  if jsonb_array_length(messages) <> 1 then
    raise exception 'T15 FAILED: expected 1 message, got %',
      jsonb_array_length(messages);
  end if;
  if jsonb_typeof(messages -> 0 -> 'githubRepositoryId') <> 'string'
     or messages -> 0 ->> 'githubRepositoryId' <> '9223372036854775807' then
    raise exception 'T15 FAILED: githubRepositoryId lost BIGINT precision';
  end if;
  if messages -> 0 ->> 'senderUserId' <> 'a1000000-0000-4000-8000-000000000001' then
    raise exception 'T15 FAILED: the approving human was not recorded as sender';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T16  An empty conversation lists as [] rather than null
-- ---------------------------------------------------------------------------
do $$
declare
  messages jsonb;
begin
  messages := public.list_shared_messages(
    'a3000000-0000-4000-8000-000000000002', 1000);

  if messages is null or messages <> '[]'::jsonb then
    raise exception 'T16 FAILED: an empty conversation returned %', messages;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T17  Send is atomic: a failure inside it leaves no partial delivery
--
-- The message insert is forced to violate the primary key after the draft has
-- already been updated to 'sent'. The whole function must roll back.
-- ---------------------------------------------------------------------------
do $$
declare
  state_after text;
  sent        int;
  approvals   int;
begin
  perform public.create_private_draft(
    'a4000000-0000-4000-8000-000000000003',
    'a3000000-0000-4000-8000-000000000001',
    9223372036854775807,
    'a1000000-0000-4000-8000-000000000001',
    'codex', 'summarize the retry policy',
    '2026-08-31T09:02:00Z', '2026-08-31T09:02:00Z');
  perform public.mark_private_draft_running(
    'a4000000-0000-4000-8000-000000000003',
    'a1000000-0000-4000-8000-000000000001',
    'a5000000-0000-4000-8000-000000000004',
    '2026-08-31T09:02:01Z');
  perform public.complete_private_draft(
    'a4000000-0000-4000-8000-000000000003',
    'a5000000-0000-4000-8000-000000000004',
    'ready', 'Retries back off exponentially.', 'Retries back off exponentially.',
    '[]'::jsonb, '[]'::jsonb, '2026-08-31T09:02:02Z');

  begin
    -- Reusing the delivered message ID makes the shared_messages insert fail.
    perform public.send_private_draft(
      'a4000000-0000-4000-8000-000000000003',
      'a1000000-0000-4000-8000-000000000001',
      'Retries back off exponentially.', 'send-3',
      'a6000000-0000-4000-8000-000000000001',
      'a3000000-0000-4000-8000-000000000001',
      9223372036854775807, 'codex', '2026-08-31T09:02:03Z',
      'a7000000-0000-4000-8000-000000000003',
      '2026-08-31T09:02:03Z', '2026-08-31T09:02:03Z');
    raise exception 'T17 FAILED: a duplicate message ID was accepted';
  exception when unique_violation then
    null;
  end;

  select state into state_after from public.private_drafts
  where draft_id = 'a4000000-0000-4000-8000-000000000003';
  select count(*) into sent from public.shared_messages;
  select count(*) into approvals from public.outbound_approvals;

  if state_after <> 'ready' then
    raise exception 'T17 FAILED: the draft stayed % after a rolled-back send',
      state_after;
  end if;
  if sent <> 1 or approvals <> 1 then
    raise exception 'T17 FAILED: a rolled-back send left % message(s), % approval(s)',
      sent, approvals;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T18  Idempotency keys are scoped per actor
--
-- Two people approving under the same key must both be delivered: a shared key
-- space would let one user's retry silently swallow another user's message.
-- ---------------------------------------------------------------------------
do $$
declare
  result jsonb;
  sent   int;
begin
  perform public.create_private_draft(
    'a4000000-0000-4000-8000-000000000004',
    'a3000000-0000-4000-8000-000000000001',
    9223372036854775807,
    'a1000000-0000-4000-8000-000000000002',
    'codex', 'confirm the rounding fix',
    '2026-08-31T09:03:00Z', '2026-08-31T09:03:00Z');
  perform public.mark_private_draft_running(
    'a4000000-0000-4000-8000-000000000004',
    'a1000000-0000-4000-8000-000000000002',
    'a5000000-0000-4000-8000-000000000005',
    '2026-08-31T09:03:00Z');
  perform public.complete_private_draft(
    'a4000000-0000-4000-8000-000000000004',
    'a5000000-0000-4000-8000-000000000005',
    'ready', 'Confirmed on our side.', 'Confirmed on our side.',
    '[]'::jsonb, '[]'::jsonb, '2026-08-31T09:03:00Z');

  result := public.send_private_draft(
    'a4000000-0000-4000-8000-000000000004',
    'a1000000-0000-4000-8000-000000000002',
    'Confirmed on our side.', 'send-1',
    'a6000000-0000-4000-8000-000000000002',
    'a3000000-0000-4000-8000-000000000001',
    9223372036854775807, 'codex', '2026-08-31T09:03:01Z',
    'a7000000-0000-4000-8000-000000000002',
    '2026-08-31T09:03:01Z', '2026-08-31T09:03:01Z');

  if result is null or (result -> 'replayed')::boolean then
    raise exception 'T18 FAILED: a second user reusing key send-1 was treated as a replay';
  end if;

  select count(*) into sent from public.shared_messages;
  if sent <> 2 then
    raise exception 'T18 FAILED: expected 2 shared messages, found %', sent;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T19  Browser roles cannot execute the RPCs; the backend role can
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    set local role anon;
    perform public.list_shared_messages(
      'a3000000-0000-4000-8000-000000000001', 10);
    reset role;
    raise exception 'T19 FAILED: anon executed a conversation RPC';
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  begin
    set local role authenticated;
    perform public.get_private_draft('a4000000-0000-4000-8000-000000000001');
    reset role;
    raise exception 'T19 FAILED: authenticated read a private draft';
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  begin
    set local role anon;
    perform 1 from public.private_drafts;
    reset role;
    raise exception 'T19 FAILED: anon selected from private_drafts';
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  -- Asserting the transcript is non-empty, not merely non-null: row level
  -- security with no policies returns zero rows rather than an error, so a
  -- backend role that had lost its access would still return a valid `[]`.
  set local role service_role;
  if jsonb_array_length(public.list_shared_messages(
       'a3000000-0000-4000-8000-000000000001', 10)) = 0 then
    reset role;
    raise exception 'T19 FAILED: service_role could not read the shared transcript';
  end if;
  reset role;
end $$;

-- ---------------------------------------------------------------------------
-- T20  Private drafting never leaks through the shared transcript
-- ---------------------------------------------------------------------------
do $$
declare
  serialized text;
begin
  serialized := public.list_shared_messages(
    'a3000000-0000-4000-8000-000000000001', 1000)::text;

  -- The private room asked and answered these; only the approved body crossed.
  if serialized like '%which storefront?%'
     or serialized like '%only the EU storefront%'
     or serialized like '%rough_message%'
     or serialized like '%roughMessage%'
     or serialized like '%privateTurns%'
     or serialized like '%sendCandidate%'
     or serialized like '%guardFindings%' then
    raise exception 'T20 FAILED: private draft state reached the shared transcript';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T21  The backend role can drive a whole draft, not just read one
--
-- The RPCs are security invoker, so a privilege the migration forgets to grant
-- is invisible to the database owner and fails only in production. Running one
-- full lifecycle as service_role is what surfaces that.
-- ---------------------------------------------------------------------------
do $$
declare
  draft  jsonb;
  result jsonb;
begin
  set local role service_role;

  draft := public.create_private_draft(
    'a4000000-0000-4000-8000-000000000005',
    'a3000000-0000-4000-8000-000000000001',
    9223372036854775807,
    'a1000000-0000-4000-8000-000000000001',
    'claude', 'ask about the rounding fix',
    '2026-08-31T09:04:00Z', '2026-08-31T09:04:00Z');
  if draft is null then
    reset role;
    raise exception 'T21 FAILED: service_role could not create a draft';
  end if;

  perform public.mark_private_draft_running(
    'a4000000-0000-4000-8000-000000000005',
    'a1000000-0000-4000-8000-000000000001',
    'a5000000-0000-4000-8000-000000000006',
    '2026-08-31T09:04:01Z');
  draft := public.complete_private_draft(
    'a4000000-0000-4000-8000-000000000005',
    'a5000000-0000-4000-8000-000000000006',
    'ready', 'Shipped in 2.4.1.', 'Shipped in 2.4.1.',
    '[]'::jsonb, '[]'::jsonb, '2026-08-31T09:04:02Z');
  if draft ->> 'state' <> 'ready' then
    reset role;
    raise exception 'T21 FAILED: service_role could not complete a turn';
  end if;

  result := public.send_private_draft(
    'a4000000-0000-4000-8000-000000000005',
    'a1000000-0000-4000-8000-000000000001',
    'Shipped in 2.4.1.', 'send-4',
    'a6000000-0000-4000-8000-000000000003',
    'a3000000-0000-4000-8000-000000000001',
    9223372036854775807, 'claude', '2026-08-31T09:04:03Z',
    'a7000000-0000-4000-8000-000000000005',
    '2026-08-31T09:04:03Z', '2026-08-31T09:04:03Z');
  if result is null or (result -> 'replayed')::boolean then
    reset role;
    raise exception 'T21 FAILED: service_role could not deliver an approved message';
  end if;

  if jsonb_array_length(public.list_shared_messages(
       'a3000000-0000-4000-8000-000000000001', 1000)) <> 3 then
    reset role;
    raise exception 'T21 FAILED: the delivered message is missing from the transcript';
  end if;

  reset role;
end $$;

select 'all conversation lifecycle tests passed' as result;

rollback;
