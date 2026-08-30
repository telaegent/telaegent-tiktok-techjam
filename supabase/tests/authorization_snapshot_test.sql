-- Reproducible tests for load_private_runtime_authorization_snapshot.
--
-- Run the whole file in the Supabase SQL Editor, or with psql. It creates its
-- own fixtures inside one transaction and ends with ROLLBACK, so it leaves the
-- database unchanged. Any failure raises and aborts.
--
-- Covers, per review:
--   T1  two-person conversation while the caller has an unrelated third
--       connection in the same project
--   T2  pending and revoked participant connections are still returned
--   T3  connections from an unrelated project are excluded
--   T4  participant and connection arrays are bounded
--   T5  a cross-project conversation participant is rejected
--   T6  a runtime binding without project membership is rejected
--   T7  anon and authenticated cannot execute the RPC; service_role can

begin;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- Users. auth.users is the identity table user_accounts references.
insert into auth.users (id, aud, role, email, created_at, updated_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'caller@example.test',      now(), now()),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'participant@example.test', now(), now()),
  ('cccccccc-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'unrelated@example.test',   now(), now()),
  ('eeeeeeee-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'pending@example.test',     now(), now()),
  ('ffffffff-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'revoked@example.test',     now(), now()),
  ('99999999-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'otherproject@example.test',now(), now());

insert into public.user_accounts (user_id, status) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'active'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'active'),
  ('cccccccc-0000-4000-8000-000000000003', 'active'),
  ('eeeeeeee-0000-4000-8000-000000000004', 'active'),
  ('ffffffff-0000-4000-8000-000000000005', 'active'),
  ('99999999-0000-4000-8000-000000000006', 'active');

insert into public.github_connections
  (github_connection_id, user_id, github_user_id, github_login, status, connected_at, last_verified_at)
values
  ('11111111-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   5001, 'caller', 'connected', now(), now());

-- Two projects. P1 is the project under test; P2 exists only to prove that its
-- connections never leak into a P1 snapshot.
insert into public.repository_projects
  (project_id, github_repository_id, repository_full_name, visibility, default_branch, status)
values
  ('0a111111-0000-4000-8000-000000000001', 1001, 'telaegent/p1', 'private', 'main', 'active'),
  ('0b222222-0000-4000-8000-000000000002', 2002, 'telaegent/p2', 'private', 'main', 'active');

insert into public.github_repository_access
  (user_id, github_connection_id, github_repository_id, status, verified_at)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001',
   1001, 'verified', now());

insert into public.project_memberships (project_id, user_id, status) values
  ('0a111111-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'active'),
  ('0a111111-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002', 'active'),
  ('0a111111-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000003', 'active'),
  ('0a111111-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000004', 'active'),
  ('0a111111-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000005', 'active'),
  ('0b222222-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'active'),
  ('0b222222-0000-4000-8000-000000000002', '99999999-0000-4000-8000-000000000006', 'active');

-- Caller's connections in P1: one to the conversation participant, one to an
-- unrelated collaborator, one pending, one revoked. Plus one in P2.
insert into public.project_connections
  (project_connection_id, project_id, requester_user_id, recipient_user_id,
   status, requested_at, accepted_at, revoked_at)
values
  ('c0000001-0000-4000-8000-000000000001', '0a111111-0000-4000-8000-000000000001',
   'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002',
   'connected', now() - interval '5 min', now() - interval '4 min', null),
  ('c0000002-0000-4000-8000-000000000002', '0a111111-0000-4000-8000-000000000001',
   'aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000003',
   'connected', now() - interval '4 min', now() - interval '3 min', null),
  ('c0000003-0000-4000-8000-000000000003', '0a111111-0000-4000-8000-000000000001',
   'aaaaaaaa-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000004',
   'pending', now() - interval '3 min', null, null),
  ('c0000004-0000-4000-8000-000000000004', '0a111111-0000-4000-8000-000000000001',
   'ffffffff-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001',
   'revoked', now() - interval '2 min', now() - interval '2 min', now() - interval '1 min'),
  ('c0000005-0000-4000-8000-000000000005', '0b222222-0000-4000-8000-000000000002',
   'aaaaaaaa-0000-4000-8000-000000000001', '99999999-0000-4000-8000-000000000006',
   'connected', now() - interval '6 min', now() - interval '6 min', null);

-- Three conversations in P1.
insert into public.project_conversations (conversation_id, project_id, status) values
  ('0c000001-0000-4000-8000-000000000001', '0a111111-0000-4000-8000-000000000001', 'active'),
  ('0c000002-0000-4000-8000-000000000002', '0a111111-0000-4000-8000-000000000001', 'active'),
  ('0c000003-0000-4000-8000-000000000003', '0a111111-0000-4000-8000-000000000001', 'active');

insert into public.conversation_participants (conversation_id, project_id, user_id) values
  -- CV1: caller and one participant only.
  ('0c000001-0000-4000-8000-000000000001', '0a111111-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('0c000001-0000-4000-8000-000000000001', '0a111111-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002'),
  -- CV2: caller plus the pending and revoked counterparties.
  ('0c000002-0000-4000-8000-000000000002', '0a111111-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('0c000002-0000-4000-8000-000000000002', '0a111111-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000004'),
  ('0c000002-0000-4000-8000-000000000002', '0a111111-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000005'),
  -- CV3: five participants, for the overflow bound.
  ('0c000003-0000-4000-8000-000000000003', '0a111111-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('0c000003-0000-4000-8000-000000000003', '0a111111-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002'),
  ('0c000003-0000-4000-8000-000000000003', '0a111111-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000003'),
  ('0c000003-0000-4000-8000-000000000003', '0a111111-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000004'),
  ('0c000003-0000-4000-8000-000000000003', '0a111111-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000005');

insert into public.runtime_bindings
  (runtime_binding_id, user_id, project_id, github_repository_id, status)
values
  ('0d000001-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   '0a111111-0000-4000-8000-000000000001', 1001, 'ready');

-- ---------------------------------------------------------------------------
-- T1  Two-person conversation with an unrelated third connection present
-- ---------------------------------------------------------------------------
do $$
declare
  snapshot jsonb;
  connection_count int;
  counterparty uuid;
begin
  snapshot := public.load_private_runtime_authorization_snapshot(
    'aaaaaaaa-0000-4000-8000-000000000001', 1001,
    '0c000001-0000-4000-8000-000000000001', 10);

  if snapshot is null then
    raise exception 'T1 FAILED: snapshot is null';
  end if;

  if (select count(*) from jsonb_object_keys(snapshot)) <> 8 then
    raise exception 'T1 FAILED: expected exactly 8 top-level keys, got %',
      (select count(*) from jsonb_object_keys(snapshot));
  end if;

  connection_count := jsonb_array_length(snapshot -> 'projectConnections');
  if connection_count <> 1 then
    raise exception 'T1 FAILED: expected 1 connection scoped to the conversation, got %',
      connection_count;
  end if;

  counterparty := (snapshot -> 'projectConnections' -> 0 ->> 'recipientUserId')::uuid;
  if counterparty <> 'bbbbbbbb-0000-4000-8000-000000000002' then
    raise exception 'T1 FAILED: unexpected counterparty %', counterparty;
  end if;

  -- Cloud state must never contain the connector's local workspace path.
  if snapshot -> 'runtimeBinding' ? 'workspacePath' then
    raise exception 'T1 FAILED: binding leaked workspacePath';
  end if;

  -- Repository identifiers must be decimal text, never JSON numbers.
  if jsonb_typeof(snapshot -> 'project' -> 'githubRepositoryId') <> 'string' then
    raise exception 'T1 FAILED: githubRepositoryId is not a string';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T2  Pending and revoked participant connections still reach the policy layer
-- ---------------------------------------------------------------------------
do $$
declare
  snapshot jsonb;
  statuses text[];
begin
  snapshot := public.load_private_runtime_authorization_snapshot(
    'aaaaaaaa-0000-4000-8000-000000000001', 1001,
    '0c000002-0000-4000-8000-000000000002', 10);

  select array_agg(value ->> 'status' order by value ->> 'status')
  into statuses
  from jsonb_array_elements(snapshot -> 'projectConnections');

  if statuses is distinct from array['pending', 'revoked'] then
    raise exception 'T2 FAILED: expected pending and revoked, got %', statuses;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T3  Connections from an unrelated project are excluded
-- ---------------------------------------------------------------------------
do $$
declare
  snapshot jsonb;
  leaked int;
begin
  snapshot := public.load_private_runtime_authorization_snapshot(
    'aaaaaaaa-0000-4000-8000-000000000001', 1001,
    '0c000001-0000-4000-8000-000000000001', 10);

  select count(*)
  into leaked
  from jsonb_array_elements(snapshot -> 'projectConnections') as element
  where element ->> 'projectId' <> '0a111111-0000-4000-8000-000000000001';

  if leaked <> 0 then
    raise exception 'T3 FAILED: % connection(s) from another project leaked', leaked;
  end if;

  -- A conversation belonging to another project must not resolve at all.
  snapshot := public.load_private_runtime_authorization_snapshot(
    'aaaaaaaa-0000-4000-8000-000000000001', 2002,
    '0c000001-0000-4000-8000-000000000001', 10);

  if snapshot -> 'conversation' <> 'null'::jsonb then
    raise exception 'T3 FAILED: cross-project conversation resolved';
  end if;

  if jsonb_array_length(snapshot -> 'projectConnections') <> 0 then
    raise exception 'T3 FAILED: connections returned for a cross-project conversation';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T4  Participant and connection arrays are bounded
-- ---------------------------------------------------------------------------
do $$
declare
  snapshot jsonb;
  participant_count int;
  connection_count int;
begin
  -- Five participants exist; with p_max = 1 the bound is 1 + 2 = 3.
  snapshot := public.load_private_runtime_authorization_snapshot(
    'aaaaaaaa-0000-4000-8000-000000000001', 1001,
    '0c000003-0000-4000-8000-000000000003', 1);

  participant_count := jsonb_array_length(
    snapshot -> 'conversation' -> 'participantUserIds');
  if participant_count <> 3 then
    raise exception 'T4 FAILED: expected participants bounded to 3, got %',
      participant_count;
  end if;

  -- Participants are truncated to the three lowest ids, so only the two
  -- connections to those participants qualify; the sentinel bound is also 2.
  connection_count := jsonb_array_length(snapshot -> 'projectConnections');
  if connection_count <> 2 then
    raise exception 'T4 FAILED: expected connections bounded to 2, got %',
      connection_count;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T5  A cross-project conversation participant is rejected
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    -- CV1 belongs to P1; claiming P2 must violate the composite FK.
    insert into public.conversation_participants (conversation_id, project_id, user_id)
    values ('0c000001-0000-4000-8000-000000000001',
            '0b222222-0000-4000-8000-000000000002',
            '99999999-0000-4000-8000-000000000006');
    raise exception 'T5 FAILED: cross-project participant was accepted';
  exception when foreign_key_violation then
    null;
  end;

  begin
    -- A participant who is not a member of the project must be rejected too.
    insert into public.conversation_participants (conversation_id, project_id, user_id)
    values ('0c000001-0000-4000-8000-000000000001',
            '0a111111-0000-4000-8000-000000000001',
            '99999999-0000-4000-8000-000000000006');
    raise exception 'T5 FAILED: non-member participant was accepted';
  exception when foreign_key_violation then
    null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- T6  A runtime binding without project membership is rejected
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into public.runtime_bindings
      (user_id, project_id, github_repository_id, status)
    values ('99999999-0000-4000-8000-000000000006',
            '0a111111-0000-4000-8000-000000000001', 1001, 'provisioning');
    raise exception 'T6 FAILED: binding without membership was accepted';
  exception when foreign_key_violation then
    null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- T7  Role-based execution
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    set local role anon;
    perform public.load_private_runtime_authorization_snapshot(
      'aaaaaaaa-0000-4000-8000-000000000001', 1001,
      '0c000001-0000-4000-8000-000000000001', 10);
    reset role;
    raise exception 'T7 FAILED: anon executed the RPC';
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  begin
    set local role authenticated;
    perform public.load_private_runtime_authorization_snapshot(
      'aaaaaaaa-0000-4000-8000-000000000001', 1001,
      '0c000001-0000-4000-8000-000000000001', 10);
    reset role;
    raise exception 'T7 FAILED: authenticated executed the RPC';
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  set local role service_role;
  if public.load_private_runtime_authorization_snapshot(
       'aaaaaaaa-0000-4000-8000-000000000001', 1001,
       '0c000001-0000-4000-8000-000000000001', 10) is null then
    reset role;
    raise exception 'T7 FAILED: service_role received a null snapshot';
  end if;
  reset role;
end $$;

-- ---------------------------------------------------------------------------
-- Out-of-range parameter is rejected by the domain
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    perform public.load_private_runtime_authorization_snapshot(
      'aaaaaaaa-0000-4000-8000-000000000001', 1001,
      '0c000001-0000-4000-8000-000000000001', 0);
    raise exception 'BOUND FAILED: p_max_project_connections = 0 was accepted';
  exception when check_violation then
    null;
  end;

  begin
    perform public.load_private_runtime_authorization_snapshot(
      'aaaaaaaa-0000-4000-8000-000000000001', 1001,
      '0c000001-0000-4000-8000-000000000001', 101);
    raise exception 'BOUND FAILED: p_max_project_connections = 101 was accepted';
  exception when check_violation then
    null;
  end;
end $$;

select 'all authorization snapshot tests passed' as result;

rollback;
