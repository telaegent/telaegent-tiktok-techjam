-- Transactional scope, lifecycle, idempotency and ACL tests for
-- disconnect_user_repository. Run in SQL Editor or psql; leaves no rows.
begin;

do $$
declare
  v_alice       uuid := 'd1000000-0000-4000-8000-000000000001';
  v_bob         uuid := 'd1000000-0000-4000-8000-000000000002';
  v_outsider    uuid := 'd1000000-0000-4000-8000-000000000003';
  v_project     uuid := 'd2000000-0000-4000-8000-000000000001';
  v_other       uuid := 'd2000000-0000-4000-8000-000000000002';
  v_conversation uuid := 'd3000000-0000-4000-8000-000000000001';
  v_message     uuid := 'd4000000-0000-4000-8000-000000000001';
  v_task        uuid := 'd5000000-0000-4000-8000-000000000001';
  v_result      jsonb;
begin
  insert into auth.users (id, aud, role, email, created_at, updated_at) values
    (v_alice, 'authenticated', 'authenticated', 'disconnect-alice@example.test', now(), now()),
    (v_bob, 'authenticated', 'authenticated', 'disconnect-bob@example.test', now(), now()),
    (v_outsider, 'authenticated', 'authenticated', 'disconnect-outsider@example.test', now(), now());
  insert into public.user_accounts (user_id, status) values
    (v_alice, 'active'), (v_bob, 'active'), (v_outsider, 'active');

  insert into public.github_connections
    (github_connection_id, user_id, github_user_id, github_login, status,
     connected_at, last_verified_at)
  values
    ('d6000000-0000-4000-8000-000000000001', v_alice, 6101, 'disconnect-alice',
     'connected', now(), now()),
    ('d6000000-0000-4000-8000-000000000002', v_bob, 6102, 'disconnect-bob',
     'connected', now(), now());
  insert into public.repository_projects
    (project_id, github_repository_id, repository_full_name, visibility,
     default_branch, status)
  values
    (v_project, 6201, 'telaegent/disconnect-a', 'private', 'main', 'active'),
    (v_other, 6202, 'telaegent/disconnect-b', 'private', 'main', 'active');
  insert into public.github_repository_access
    (user_id, github_connection_id, github_repository_id, status, verified_at)
  values
    (v_alice, 'd6000000-0000-4000-8000-000000000001', 6201, 'verified', now()),
    (v_alice, 'd6000000-0000-4000-8000-000000000001', 6202, 'verified', now()),
    (v_bob, 'd6000000-0000-4000-8000-000000000002', 6201, 'verified', now());
  insert into public.project_memberships (project_id, user_id, status) values
    (v_project, v_alice, 'active'), (v_project, v_bob, 'active'),
    (v_other, v_alice, 'active');
  insert into public.runtime_bindings
    (runtime_binding_id, user_id, project_id, github_repository_id, status,
     connector_instance_id, current_branch, commit_sha, repository_permission,
     last_verified_at, last_seen_at)
  values
    ('d7000000-0000-4000-8000-000000000001', v_alice, v_project, 6201, 'ready',
     'disconnect_instance_a1', 'main', repeat('a', 40), 'write', now(), now()),
    ('d7000000-0000-4000-8000-000000000002', v_bob, v_project, 6201, 'ready',
     'disconnect_instance_b1', 'main', repeat('b', 40), 'write', now(), now()),
    ('d7000000-0000-4000-8000-000000000003', v_alice, v_other, 6202, 'ready',
     'disconnect_instance_a2', 'main', repeat('c', 40), 'write', now(), now());

  insert into public.project_conversations (conversation_id, project_id, status)
  values (v_conversation, v_project, 'active');
  insert into public.conversation_participants (conversation_id, project_id, user_id)
  values (v_conversation, v_project, v_alice), (v_conversation, v_project, v_bob);
  insert into public.shared_messages
    (message_id, conversation_id, github_repository_id, sender_user_id, body,
     origin, provider, sent_at)
  values (v_message, v_conversation, 6201, v_bob, 'approved request',
          'agent', 'codex', now());
  insert into public.collaboration_tasks
    (task_id, project_id, conversation_id, github_repository_id,
     requester_user_id, responder_user_id, origin_shared_message_id, status,
     created_at, expires_at, ended_at, follow_up_rounds)
  values (v_task, v_project, v_conversation, 6201, v_bob, v_alice, v_message,
          'active', now(), now() + interval '1 hour', null, 1);
  insert into public.resource_capability_grants
    (grant_id, task_id, owner_user_id, peer_user_id, resource_id, operation,
     grant_mode, status, granted_by_user_id, granted_at, expires_at)
  values ('d8000000-0000-4000-8000-000000000001', v_task, v_alice, v_bob,
          'resource_abcdefghijklmnop', 'read', 'task', 'active', v_alice,
          now(), now() + interval '30 minutes');

  -- T1: the owner can disconnect exactly the selected project.
  v_result := public.disconnect_user_repository(v_alice, v_project);
  if v_result #>> '{projectId}' <> v_project::text
     or v_result #>> '{githubRepositoryId}' <> '6201'
     or v_result #>> '{repositoryAccessStatus}' <> 'revalidation_required'
     or v_result #>> '{membershipStatus}' <> 'suspended'
     or v_result #>> '{bindingStatus}' <> 'stopped'
     or v_result #>> '{changed}' <> 'true' then
    raise exception 'T1 FAILED: unexpected disconnect result %', v_result;
  end if;

  -- T2: old connector mapping and active task authority are retired.
  if not exists (
    select 1 from public.runtime_bindings
    where user_id = v_alice and project_id = v_project and status = 'stopped'
      and connector_instance_id is null and current_branch is null
      and commit_sha is null and repository_permission is null
  ) or not exists (
    select 1 from public.collaboration_tasks
    where task_id = v_task and status = 'cancelled' and ended_at is not null
  ) or not exists (
    select 1 from public.resource_capability_grants
    where task_id = v_task and status = 'revoked' and revoked_at is not null
  ) then
    raise exception 'T2 FAILED: runtime or task authority survived disconnect';
  end if;

  -- T3: another user and another repository are untouched.
  if not exists (
    select 1 from public.runtime_bindings
    where user_id = v_bob and project_id = v_project and status = 'ready'
      and connector_instance_id = 'disconnect_instance_b1'
  ) or not exists (
    select 1 from public.runtime_bindings
    where user_id = v_alice and project_id = v_other and status = 'ready'
      and connector_instance_id = 'disconnect_instance_a2'
  ) then
    raise exception 'T3 FAILED: disconnect crossed user or repository scope';
  end if;

  -- T4: retry is idempotent; an outsider receives the same null refusal as an
  -- unknown project and learns nothing about membership.
  v_result := public.disconnect_user_repository(v_alice, v_project);
  if v_result #>> '{changed}' <> 'false' then
    raise exception 'T4 FAILED: retry was not idempotent %', v_result;
  end if;
  if public.disconnect_user_repository(v_outsider, v_project) is not null
     or public.disconnect_user_repository(v_alice,
          'd2000000-0000-4000-8000-000000000099') is not null then
    raise exception 'T4 FAILED: unauthorized scope did not fail closed';
  end if;
end;
$$;

do $$
begin
  if has_function_privilege('anon', 'public.disconnect_user_repository(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.disconnect_user_repository(uuid,uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.disconnect_user_repository(uuid,uuid)', 'EXECUTE') then
    raise exception 'T5 FAILED: disconnect RPC ACL is unsafe';
  end if;
end;
$$;

rollback;
