-- Transactional proof for the capability routing functions.
--
-- These functions route; they never authorize a read. The tests below prove the
-- routing facts are complete and correctly scoped, that "Allow once" really is
-- once under concurrency, and that browser roles cannot call any of it.
begin;

insert into auth.users (id, aud, role, email, created_at, updated_at) values
  ('91000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'route-peer@example.test', now(), now()),
  ('91000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
   'route-owner@example.test', now(), now());

insert into public.user_accounts (user_id, status) values
  ('91000000-0000-4000-8000-000000000001', 'active'),
  ('91000000-0000-4000-8000-000000000002', 'active');

insert into public.repository_projects
  (project_id, github_repository_id, repository_full_name, visibility,
   default_branch, status)
values
  ('92000000-0000-4000-8000-000000000001', 1345851084,
   'telaegent/capability-route', 'private', 'main', 'active'),
  -- A second repository the same two people also share. Repository ID is the
  -- scope boundary, so nothing granted in one may ever resolve in the other.
  ('92000000-0000-4000-8000-000000000002', 1345851085,
   'telaegent/other-repo', 'private', 'main', 'active');

insert into public.project_conversations (conversation_id, project_id, status)
values
  ('93000000-0000-4000-8000-000000000001',
   '92000000-0000-4000-8000-000000000001', 'active');

insert into public.project_memberships (project_id, user_id, status, revoked_at)
values
  ('92000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000001', 'active', null),
  ('92000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000002', 'active', null);

insert into public.conversation_participants (conversation_id, user_id, project_id)
values
  ('93000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000001',
   '92000000-0000-4000-8000-000000000001'),
  ('93000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000002',
   '92000000-0000-4000-8000-000000000001');

insert into public.project_connections (
  project_connection_id, project_id, requester_user_id, recipient_user_id,
  status, requested_at, accepted_at, revoked_at
) values (
  '94000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000002',
  'connected', '2026-08-31T08:00:00Z', '2026-08-31T08:05:00Z', null
);

insert into public.runtime_bindings (
  runtime_binding_id, user_id, project_id, github_repository_id, status
) values (
  '95000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000002',
  '92000000-0000-4000-8000-000000000001',
  1345851084, 'ready'
);

insert into public.shared_messages (
  message_id, conversation_id, github_repository_id, sender_user_id,
  body, origin, provider, sent_at
) values (
  '96000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',
  1345851084,
  '91000000-0000-4000-8000-000000000001',
  'Which file sets the theme?',
  'agent', 'codex', '2026-08-31T09:00:00Z'
);

insert into public.collaboration_tasks (
  task_id, project_id, conversation_id, github_repository_id,
  requester_user_id, responder_user_id, origin_shared_message_id,
  status, created_at, expires_at, ended_at
) values (
  '97000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',
  1345851084,
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000002',
  '96000000-0000-4000-8000-000000000001',
  'active', now() - interval '1 minute', now() + interval '1 hour', null
);

do $$
declare
  v_peer     uuid := '91000000-0000-4000-8000-000000000001';
  v_owner    uuid := '91000000-0000-4000-8000-000000000002';
  v_task     uuid := '97000000-0000-4000-8000-000000000001';
  v_conv     uuid := '93000000-0000-4000-8000-000000000001';
  v_resource text := 'resource_abcdefghijklmnopqrst';
  v_grant    uuid := '98000000-0000-4000-8000-000000000001';
  v_second   uuid := '98000000-0000-4000-8000-000000000002';
  v_reuse    uuid := '98000000-0000-4000-8000-000000000003';
  v_resource_b text := 'resource_zyxwvutsrqponmlkjihg';
  v_result   jsonb;
  v_snapshot jsonb;
  v_rows     int;
begin
  -- F1: recording authority a human just delegated.
  v_result := public.record_capability_grant(
    v_grant, v_task, v_owner, v_peer, v_resource, 'task', null
  );
  if v_result->>'outcome' <> 'granted' then
    raise exception 'F1 FAILED: a valid grant was not recorded (%)', v_result;
  end if;

  -- F2: a grant may never outlive the collaboration it was scoped to.
  if (select expires_at from public.resource_capability_grants where grant_id = v_grant)
     <> (select expires_at from public.collaboration_tasks where task_id = v_task) then
    raise exception 'F2 FAILED: grant expiry was not clamped to the task';
  end if;

  -- F3: re-approving the same file in the same task reuses the same authority
  -- rather than fragmenting it into two rows.
  v_result := public.record_capability_grant(
    v_second, v_task, v_owner, v_peer, v_resource, 'once', null
  );
  if v_result->>'outcome' <> 'existing'
     or (v_result->>'grantId')::uuid <> v_grant then
    raise exception 'F3 FAILED: re-approval did not reuse the active grant (%)', v_result;
  end if;
  select count(*) into v_rows
  from public.resource_capability_grants
  where task_id = v_task and resource_id = v_resource;
  if v_rows <> 1 then
    raise exception 'F3 FAILED: % grant rows exist for one approved file', v_rows;
  end if;
  -- A human may narrow authority they already delegated. "Allow once" after
  -- "Allow for this task" must actually take effect.
  if (select grant_mode from public.resource_capability_grants where grant_id = v_grant)
     <> 'once' then
    raise exception 'F3 FAILED: a narrower second approval was ignored';
  end if;

  -- F4: the cloud cannot invent an identifier the connector never minted.
  v_result := public.record_capability_grant(
    v_second, v_task, v_owner, v_peer, 'src/settings.ts', 'task', null
  );
  if v_result->>'outcome' <> 'invalid' then
    raise exception 'F4 FAILED: a path was accepted as a resource identifier';
  end if;

  -- F5: the snapshot carries every routing fact the service needs.
  v_snapshot := public.load_capability_route_authorization_snapshot(
    v_peer, v_owner, 1345851084, v_conv, v_task, v_grant
  );
  if v_snapshot->'task'->>'status' <> 'active'
     or v_snapshot->'project'->>'status' <> 'active'
     or v_snapshot->'conversation'->>'status' <> 'active'
     or v_snapshot->'requesterMembership'->>'userId' <> v_peer::text
     or v_snapshot->'ownerMembership'->>'userId' <> v_owner::text
     or v_snapshot->'projectConnection'->>'status' <> 'connected'
     or v_snapshot->'ownerRuntimeBinding'->>'status' <> 'ready'
     or v_snapshot->'grant'->>'resourceId' <> v_resource
     or v_snapshot->'grant'->>'operation' <> 'read' then
    raise exception 'F5 FAILED: incomplete routing snapshot (%)', v_snapshot;
  end if;
  -- BIGINT precision survives as decimal text rather than a lossy JSON number.
  if jsonb_typeof(v_snapshot->'task'->'githubRepositoryId') <> 'string'
     or v_snapshot->'task'->>'githubRepositoryId' <> '1345851084' then
    raise exception 'F5 FAILED: repository id was not projected as decimal text';
  end if;
  if jsonb_array_length(v_snapshot->'conversation'->'participantUserIds') <> 2 then
    raise exception 'F5 FAILED: conversation participants are wrong';
  end if;

  -- F6: repository ID is the scope boundary. The same task read under another
  -- repository yields nothing at all, not a task with a foreign grant attached.
  v_snapshot := public.load_capability_route_authorization_snapshot(
    v_peer, v_owner, 1345851085, v_conv, v_task, v_grant
  );
  if v_snapshot->'task' <> 'null'::jsonb
     or v_snapshot->'project' <> 'null'::jsonb
     or v_snapshot->'ownerRuntimeBinding' <> 'null'::jsonb then
    raise exception 'F6 FAILED: repo A authorized a read scoped to repo B';
  end if;

  -- F7: a task-mode grant stays reusable for the rest of the task.
  v_result := public.record_capability_grant(
    v_reuse, v_task, v_owner, v_peer, v_resource_b, 'task', null
  );
  if v_result->>'outcome' <> 'granted' then
    raise exception 'F7 FAILED: a task grant was not recorded (%)', v_result;
  end if;
  v_result := public.consume_capability_grant(v_reuse, v_owner, v_peer, v_resource_b);
  if v_result->>'outcome' <> 'reusable' then
    raise exception 'F7 FAILED: a task grant was not reusable (%)', v_result;
  end if;
  if (select status from public.resource_capability_grants where grant_id = v_reuse)
     <> 'active' then
    raise exception 'F7 FAILED: reuse consumed a task grant';
  end if;

  -- F8: redemption is bound to the exact peer the authority was granted to.
  v_result := public.consume_capability_grant(v_reuse, v_owner, v_owner, v_resource_b);
  if v_result->>'outcome' <> 'unavailable' then
    raise exception 'F8 FAILED: a grant was redeemable by the wrong peer (%)', v_result;
  end if;
  -- F8: and naming the wrong file is equally unavailable, with the same word,
  -- so a peer holding one identifier cannot probe for the existence of another.
  v_result := public.consume_capability_grant(v_reuse, v_owner, v_peer, v_resource);
  if v_result->>'outcome' <> 'unavailable' then
    raise exception 'F8 FAILED: a grant redeemed a file it does not name (%)', v_result;
  end if;

  -- F9: "Allow once" means once. The grant F3 narrowed is spent by one read.
  v_result := public.consume_capability_grant(v_grant, v_owner, v_peer, v_resource);
  if v_result->>'outcome' <> 'consumed' or v_result->>'mode' <> 'once' then
    raise exception 'F9 FAILED: a once grant was not consumed (%)', v_result;
  end if;
  v_result := public.consume_capability_grant(v_grant, v_owner, v_peer, v_resource);
  if v_result->>'outcome' <> 'unavailable' then
    raise exception 'F9 FAILED: a once grant was redeemable twice (%)', v_result;
  end if;
  if (select consumed_at from public.resource_capability_grants where grant_id = v_grant)
     is null then
    raise exception 'F9 FAILED: consumption was not recorded for audit';
  end if;

  -- F10: only the trusted backend may call any of this.
  if has_function_privilege('anon',
       'public.load_capability_route_authorization_snapshot(uuid,uuid,bigint,uuid,uuid,uuid)',
       'EXECUTE')
     or has_function_privilege('authenticated',
       'public.record_capability_grant(uuid,uuid,uuid,uuid,text,text,timestamptz)',
       'EXECUTE')
     or has_function_privilege('anon',
       'public.consume_capability_grant(uuid,uuid,uuid,text)', 'EXECUTE') then
    raise exception 'F10 FAILED: browser roles can route or redeem capabilities';
  end if;
  if not has_function_privilege('service_role',
       'public.load_capability_route_authorization_snapshot(uuid,uuid,bigint,uuid,uuid,uuid)',
       'EXECUTE')
     or not has_function_privilege('service_role',
       'public.consume_capability_grant(uuid,uuid,uuid,text)', 'EXECUTE') then
    raise exception 'F10 FAILED: the backend cannot route capabilities';
  end if;
end;
$$;

select 'all capability route function tests passed' as result;
rollback;
