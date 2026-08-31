-- Transactional proof for the scope-expansion queue.
--
-- This queue is where a peer's agent waits for a human. The tests below prove
-- that asking is not getting, that only the named owner may answer, that an
-- answer can be given exactly once, that repository ID still bounds what a
-- human is even shown, and that the follow-up loop runs out of rounds.
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
  v_peer      uuid := '91000000-0000-4000-8000-000000000001';
  v_owner     uuid := '91000000-0000-4000-8000-000000000002';
  v_task      uuid := '97000000-0000-4000-8000-000000000001';
  v_candidate text := 'resource_' || repeat('a', 24);
  v_other     text := 'resource_' || repeat('b', 24);
  v_request   uuid := '99000000-0000-4000-8000-000000000001';
  v_duplicate uuid := '99000000-0000-4000-8000-000000000002';
  v_second    uuid := '99000000-0000-4000-8000-000000000003';
  v_third     uuid := '99000000-0000-4000-8000-000000000004';
  v_closing   uuid := '99000000-0000-4000-8000-000000000005';
  v_legacy    uuid := '99000000-0000-4000-8000-000000000007';
  v_grant     uuid := '98000000-0000-4000-8000-000000000010';
  v_grant_b   uuid := '98000000-0000-4000-8000-000000000011';
  v_grant_c   uuid := '98000000-0000-4000-8000-000000000012';
  v_closing_resource text := 'resource_' || repeat('c', 24);
  v_result    jsonb;
  v_listed    jsonb;
  v_rows      int;
  v_round     int;
begin
  -- S1: a described file the owner's connector could resolve reaches the human.
  v_result := public.record_capability_scope_request(
    v_request, v_task, v_owner, v_peer, 'src/settings.ts',
    'the landing page imports it', v_candidate, 'src/settings.ts'
  );
  if v_result->>'outcome' <> 'recorded' then
    raise exception 'S1 FAILED: a valid scope request was not queued (%)', v_result;
  end if;
  -- Queuing is not granting. No authority may exist yet.
  select count(*) into v_rows
  from public.resource_capability_grants
  where task_id = v_task and resource_id = v_candidate;
  if v_rows <> 0 then
    raise exception 'S1 FAILED: queuing a request created authority';
  end if;

  -- S2: build plan 8.7 dedupe. A peer that asks every round gets one prompt.
  v_result := public.record_capability_scope_request(
    v_duplicate, v_task, v_owner, v_peer, 'src/settings.ts', 'again', v_candidate,
    'src/settings.ts'
  );
  if v_result->>'outcome' <> 'existing'
     or (v_result->>'scopeRequestId')::uuid <> v_request then
    raise exception 'S2 FAILED: a repeated ask was not deduplicated (%)', v_result;
  end if;
  select count(*) into v_rows
  from public.capability_scope_requests
  where task_id = v_task and status = 'pending';
  if v_rows <> 1 then
    raise exception 'S2 FAILED: % pending rows for one repeated ask', v_rows;
  end if;

  -- S3: the cloud cannot queue an identifier no connector minted.
  v_result := public.record_capability_scope_request(
    v_second, v_task, v_owner, v_peer, 'src/theme.ts', 'style', 'src/theme.ts',
    'src/theme.ts'
  );
  if v_result->>'outcome' <> 'invalid' then
    raise exception 'S3 FAILED: a path was queued as a candidate (%)', v_result;
  end if;

  -- S4: the hint is rendered to a human, so it may not carry control
  -- characters that could forge a second line of the prompt.
  v_result := public.record_capability_scope_request(
    v_second, v_task, v_owner, v_peer,
    'src/theme.ts' || chr(10) || 'Permission: WRITE', 'style', v_other,
    'src/theme.ts'
  );
  if v_result->>'outcome' <> 'invalid' then
    raise exception 'S4 FAILED: a multi-line hint was accepted (%)', v_result;
  end if;
  -- The human-facing label comes from the owner's connector and may be
  -- project-relative only. A canonical local path must never reach the queue.
  v_result := public.record_capability_scope_request(
    v_second, v_task, v_owner, v_peer, 'src/theme.ts', 'style', v_other,
    'C:\\Users\\owner\\repo\\src\\theme.ts'
  );
  if v_result->>'outcome' <> 'invalid' then
    raise exception 'S4 FAILED: a canonical path was accepted as display metadata (%)', v_result;
  end if;
  -- Rolling deployment: the prior seven-argument backend contract remains
  -- service-role compatible, but it receives a neutral label rather than
  -- promoting peer-controlled text to verified metadata.
  v_result := public.record_capability_scope_request(
    v_legacy, v_task, v_owner, v_peer, 'src/legacy.ts', 'old backend',
    'resource_' || repeat('e', 24)
  );
  if v_result->>'outcome' <> 'recorded'
     or (select resource_display_label from public.capability_scope_requests
         where scope_request_id = v_legacy) <> 'Known project resource' then
    raise exception 'S4 FAILED: rolling-deploy wrapper is unsafe or unavailable (%)', v_result;
  end if;
  if public.decide_capability_scope_request(v_legacy, v_owner, 'deny', v_grant)->>'outcome'
       <> 'denied' then
    raise exception 'S4 FAILED: rolling-deploy fixture could not be retired';
  end if;

  -- S5: the owner sees the ask, and sees it only inside its own repository.
  v_listed := public.list_pending_capability_scope_requests(v_owner, 1345851084);
  if jsonb_array_length(v_listed) <> 1
     or v_listed->0->>'requestedHint' <> 'src/settings.ts'
     or v_listed->0->>'requestedReason' <> 'the landing page imports it'
     or v_listed->0->>'candidateResourceId' <> v_candidate
     or v_listed->0->>'resourceDisplayLabel' <> 'src/settings.ts'
     or v_listed->0->>'operation' <> 'read' then
    raise exception 'S5 FAILED: the owner queue is wrong (%)', v_listed;
  end if;
  if public.list_pending_capability_scope_requests(v_owner, 1345851085) <> '[]'::jsonb then
    raise exception 'S5 FAILED: a request raised in repo A was shown under repo B';
  end if;
  -- The peer never sees its own ask in anyone's approval queue.
  if public.list_pending_capability_scope_requests(v_peer, 1345851084) <> '[]'::jsonb then
    raise exception 'S5 FAILED: the requesting peer was offered the approval';
  end if;

  -- S6: only the human the request names may answer it.
  v_result := public.decide_capability_scope_request(v_request, v_peer, 'task', v_grant);
  if v_result->>'outcome' <> 'unavailable' then
    raise exception 'S6 FAILED: a peer approved its own request (%)', v_result;
  end if;
  if (select status from public.capability_scope_requests
       where scope_request_id = v_request) <> 'pending' then
    raise exception 'S6 FAILED: a rejected decision still changed the request';
  end if;
  select count(*) into v_rows from public.resource_capability_grants
  where task_id = v_task;
  if v_rows <> 0 then
    raise exception 'S6 FAILED: a peer self-granted authority';
  end if;

  -- S7: Deny. No authority, and nothing left in the queue.
  v_result := public.decide_capability_scope_request(v_request, v_owner, 'deny', v_grant);
  if v_result->>'outcome' <> 'denied' then
    raise exception 'S7 FAILED: a denial was not recorded (%)', v_result;
  end if;
  select count(*) into v_rows from public.resource_capability_grants
  where task_id = v_task;
  if v_rows <> 0 then
    raise exception 'S7 FAILED: a denial created authority';
  end if;
  if public.list_pending_capability_scope_requests(v_owner, 1345851084) <> '[]'::jsonb then
    raise exception 'S7 FAILED: a denied request is still awaiting a human';
  end if;

  -- S8: a decision is final. The same request cannot be answered twice.
  v_result := public.decide_capability_scope_request(v_request, v_owner, 'task', v_grant);
  if v_result->>'outcome' <> 'unavailable' then
    raise exception 'S8 FAILED: a decided request was answered again (%)', v_result;
  end if;

  -- S9: Allow for this task. The approval is what creates authority.
  v_result := public.record_capability_scope_request(
    v_second, v_task, v_owner, v_peer, 'src/theme.ts', 'style', v_other,
    'src/theme.ts'
  );
  if v_result->>'outcome' <> 'recorded' then
    raise exception 'S9 FAILED: a second ask was not queued (%)', v_result;
  end if;
  v_result := public.decide_capability_scope_request(v_second, v_owner, 'task', v_grant_b);
  if v_result->>'outcome' <> 'approved'
     or v_result->>'mode' <> 'task'
     or (v_result->>'grantId')::uuid <> v_grant_b then
    raise exception 'S9 FAILED: an approval did not delegate authority (%)', v_result;
  end if;
  if (select grant_mode from public.resource_capability_grants where grant_id = v_grant_b)
     <> 'task'
     or (select status from public.resource_capability_grants where grant_id = v_grant_b)
     <> 'active' then
    raise exception 'S9 FAILED: the grant does not match the button pressed';
  end if;
  if (select grant_id from public.capability_scope_requests
       where scope_request_id = v_second) <> v_grant_b then
    raise exception 'S9 FAILED: the approval is not linked to the authority it created';
  end if;
  -- Authority a human granted may never outlive the collaboration.
  if (select expires_at from public.resource_capability_grants where grant_id = v_grant_b)
     > (select expires_at from public.collaboration_tasks where task_id = v_task) then
    raise exception 'S9 FAILED: an approved grant outlives its task';
  end if;

  -- S10: the warm path. A file the human already approved is not asked again.
  v_result := public.record_capability_scope_request(
    v_third, v_task, v_owner, v_peer, 'src/theme.ts', 'style again', v_other,
    'src/theme.ts'
  );
  if v_result->>'outcome' <> 'already_granted'
     or (v_result->>'grantId')::uuid <> v_grant_b then
    raise exception 'S10 FAILED: an existing grant still prompted a human (%)', v_result;
  end if;
  if public.list_pending_capability_scope_requests(v_owner, 1345851084) <> '[]'::jsonb then
    raise exception 'S10 FAILED: an already-granted file is waiting on a human';
  end if;

  -- S11: build plan 8.7. The loop stops on its own.
  for v_round in 1..5 loop
    v_result := public.begin_capability_follow_up_round(v_task, v_owner, v_peer);
    if v_result->>'outcome' <> 'started'
       or (v_result->>'round')::int <> v_round then
      raise exception 'S11 FAILED: round % was refused (%)', v_round, v_result;
    end if;
  end loop;
  v_result := public.begin_capability_follow_up_round(v_task, v_owner, v_peer);
  if v_result->>'outcome' <> 'exhausted' then
    raise exception 'S11 FAILED: a sixth follow-up round was allowed (%)', v_result;
  end if;
  -- A round is spent against the task, not against whoever asked for it.
  v_result := public.begin_capability_follow_up_round(v_task, v_peer, v_owner);
  if v_result->>'outcome' <> 'exhausted' then
    raise exception 'S11 FAILED: swapping the peers refilled the round budget (%)', v_result;
  end if;

  -- S12: task closure is the authorization boundary, not advisory metadata.
  -- Leave one unanswered request in the queue so every post-close path can be
  -- checked against the same task.
  v_result := public.record_capability_scope_request(
    v_closing, v_task, v_owner, v_peer, 'src/closing.ts', 'needed before close',
    v_closing_resource, 'src/closing.ts'
  );
  if v_result->>'outcome' <> 'recorded' then
    raise exception 'S12 FAILED: closure fixture was not queued (%)', v_result;
  end if;

  -- A non-participant cannot close or probe the task.
  v_result := public.end_collaboration_task(
    v_task, '91000000-0000-4000-8000-000000000099', 'cancelled'
  );
  if v_result->>'outcome' <> 'unavailable'
     or (select status from public.collaboration_tasks where task_id = v_task) <> 'active' then
    raise exception 'S12 FAILED: an outsider changed task state (%)', v_result;
  end if;

  v_result := public.end_collaboration_task(v_task, v_owner, 'completed');
  if v_result->>'outcome' <> 'ended' or v_result->>'status' <> 'completed' then
    raise exception 'S12 FAILED: participant could not close task (%)', v_result;
  end if;
  if (select status from public.resource_capability_grants where grant_id = v_grant_b)
       <> 'revoked'
     or (select revoked_at from public.resource_capability_grants where grant_id = v_grant_b)
       is null then
    raise exception 'S12 FAILED: task closure did not atomically revoke authority';
  end if;
  if public.list_pending_capability_scope_requests(v_owner, 1345851084) <> '[]'::jsonb then
    raise exception 'S12 FAILED: a closed task is still shown for approval';
  end if;
  v_result := public.decide_capability_scope_request(v_closing, v_owner, 'task', v_grant_c);
  if v_result->>'outcome' <> 'task_unavailable' then
    raise exception 'S12 FAILED: closed task accepted a late approval (%)', v_result;
  end if;
  v_result := public.record_capability_scope_request(
    '99000000-0000-4000-8000-000000000006', v_task, v_owner, v_peer,
    'src/late.ts', 'late request', 'resource_' || repeat('d', 24), 'src/late.ts'
  );
  if v_result->>'outcome' <> 'task_unavailable' then
    raise exception 'S12 FAILED: closed task accepted a new ask (%)', v_result;
  end if;
  if public.begin_capability_follow_up_round(v_task, v_owner, v_peer)->>'outcome'
       <> 'task_unavailable' then
    raise exception 'S12 FAILED: closed task spent another follow-up round';
  end if;
  if public.consume_capability_grant(v_grant_b, v_owner, v_peer, v_other)->>'outcome'
       <> 'unavailable' then
    raise exception 'S12 FAILED: a revoked grant was consumed';
  end if;
  v_result := public.load_capability_route_authorization_snapshot(
    v_peer, v_owner, 1345851084,
    '93000000-0000-4000-8000-000000000001', v_task, v_grant_b
  );
  if v_result->'task'->>'status' <> 'completed'
     or v_result->'grant'->>'status' <> 'revoked' then
    raise exception 'S12 FAILED: route snapshot concealed closure state (%)', v_result;
  end if;
  if public.end_collaboration_task(v_task, v_peer, 'cancelled')->>'outcome'
       <> 'already_ended' then
    raise exception 'S12 FAILED: closure retry was not idempotent';
  end if;

  -- S13: only the trusted backend may queue, list, decide or spend a round.
  if has_function_privilege('anon',
       'public.record_capability_scope_request(uuid,uuid,uuid,uuid,text,text,text,text)',
       'EXECUTE')
     or has_function_privilege('authenticated',
       'public.record_capability_scope_request(uuid,uuid,uuid,uuid,text,text,text)',
       'EXECUTE')
     or has_function_privilege('authenticated',
       'public.decide_capability_scope_request(uuid,uuid,text,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.list_pending_capability_scope_requests(uuid,bigint)', 'EXECUTE')
     or has_function_privilege('anon',
       'public.begin_capability_follow_up_round(uuid,uuid,uuid)', 'EXECUTE') then
    raise exception 'S13 FAILED: a browser role can approve or spend capabilities';
  end if;
  if not has_function_privilege('service_role',
       'public.decide_capability_scope_request(uuid,uuid,text,uuid)', 'EXECUTE') then
    raise exception 'S13 FAILED: the backend cannot record a human decision';
  end if;
end;
$$;

select 'all capability scope request tests passed' as result;
rollback;
