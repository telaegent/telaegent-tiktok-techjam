-- Transactional schema/security proof for task identity and exact read grants.
begin;

insert into auth.users (id, aud, role, email, created_at, updated_at) values
  ('81000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'peer@example.test', now(), now()),
  ('81000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'owner@example.test', now(), now());

insert into public.user_accounts (user_id, status) values
  ('81000000-0000-4000-8000-000000000001', 'active'),
  ('81000000-0000-4000-8000-000000000002', 'active');

insert into public.repository_projects
  (project_id, github_repository_id, repository_full_name, visibility, default_branch, status)
values
  ('82000000-0000-4000-8000-000000000001', 1345851083,
   'telaegent/capability-contract', 'private', 'main', 'active');

insert into public.project_conversations (conversation_id, project_id, status)
values
  ('83000000-0000-4000-8000-000000000001',
   '82000000-0000-4000-8000-000000000001', 'active');

insert into public.shared_messages (
  message_id, conversation_id, github_repository_id, sender_user_id,
  body, origin, provider, sent_at
) values (
  '84000000-0000-4000-8000-000000000001',
  '83000000-0000-4000-8000-000000000001',
  1345851083,
  '81000000-0000-4000-8000-000000000001',
  'Please check the exact resource already approved for this task.',
  'agent', 'codex', '2026-08-31T09:00:00Z'
);

insert into public.collaboration_tasks (
  task_id, project_id, conversation_id, github_repository_id,
  requester_user_id, responder_user_id, origin_shared_message_id,
  status, created_at, expires_at, ended_at
) values (
  '85000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001',
  '83000000-0000-4000-8000-000000000001',
  1345851083,
  '81000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000002',
  '84000000-0000-4000-8000-000000000001',
  'active', '2026-08-31T09:00:00Z', '2026-08-31T10:00:00Z', null
);

insert into public.resource_capability_grants (
  grant_id, task_id, owner_user_id, peer_user_id, resource_id,
  operation, grant_mode, status, granted_by_user_id,
  granted_at, expires_at, consumed_at, revoked_at
) values (
  '86000000-0000-4000-8000-000000000001',
  '85000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000002',
  '81000000-0000-4000-8000-000000000001',
  'resource_abcdefghijklmnop',
  'read', 'task', 'active',
  '81000000-0000-4000-8000-000000000002',
  '2026-08-31T09:01:00Z', '2026-08-31T09:55:00Z', null, null
);

do $$
declare
  forbidden_columns int;
begin
  select count(*) into forbidden_columns
  from information_schema.columns
  where table_schema = 'public'
    and table_name in ('collaboration_tasks', 'resource_capability_grants')
    and column_name ~* '(path|content|credential|session|command|executable)';
  if forbidden_columns <> 0 then
    raise exception 'T1 FAILED: capability cloud tables contain local/private fields';
  end if;

  begin
    insert into public.resource_capability_grants (
      grant_id, task_id, owner_user_id, peer_user_id, resource_id,
      operation, grant_mode, status, granted_by_user_id, granted_at, expires_at
    ) values (
      '86000000-0000-4000-8000-000000000002',
      '85000000-0000-4000-8000-000000000001',
      '81000000-0000-4000-8000-000000000002',
      '81000000-0000-4000-8000-000000000001',
      'resource_qrstuvwxyzabcdef',
      'write', 'task', 'active',
      '81000000-0000-4000-8000-000000000002',
      '2026-08-31T09:01:00Z', '2026-08-31T09:55:00Z'
    );
    raise exception 'T2 FAILED: a write grant was accepted';
  exception when check_violation then
    null;
  end;

  begin
    insert into public.resource_capability_grants (
      grant_id, task_id, owner_user_id, peer_user_id, resource_id,
      operation, grant_mode, status, granted_by_user_id, granted_at, expires_at
    ) values (
      '86000000-0000-4000-8000-000000000003',
      '85000000-0000-4000-8000-000000000001',
      '81000000-0000-4000-8000-000000000002',
      '81000000-0000-4000-8000-000000000001',
      'src/settings.ts',
      'read', 'task', 'active',
      '81000000-0000-4000-8000-000000000002',
      '2026-08-31T09:01:00Z', '2026-08-31T09:55:00Z'
    );
    raise exception 'T3 FAILED: a path was accepted as a resource ID';
  exception when check_violation then
    null;
  end;

  if has_table_privilege('anon', 'public.collaboration_tasks', 'SELECT') or
     has_table_privilege('authenticated', 'public.collaboration_tasks', 'SELECT') or
     has_table_privilege('anon', 'public.resource_capability_grants', 'SELECT') or
     has_table_privilege('authenticated', 'public.resource_capability_grants', 'SELECT') then
    raise exception 'T4 FAILED: browser roles can read task/grant metadata';
  end if;

  if not has_table_privilege('service_role', 'public.collaboration_tasks', 'SELECT') or
     not has_table_privilege('service_role', 'public.resource_capability_grants', 'SELECT') then
    raise exception 'T5 FAILED: backend cannot read task/grant metadata';
  end if;
end;
$$;

select 'all task/capability contract tests passed' as result;
rollback;
