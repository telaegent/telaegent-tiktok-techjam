-- Transactional privacy, pagination, and ACL tests for project discovery.
begin;

do $$
declare
  v_user uuid := '10000000-0000-4000-8000-000000000001';
  v_peer uuid := '10000000-0000-4000-8000-000000000002';
  v_page jsonb;
begin
  insert into public.user_accounts (user_id, status) values
    (v_user, 'active'),
    (v_peer, 'active');

  insert into public.github_connections (
    github_connection_id, user_id, github_user_id, github_login, status,
    connected_at, last_verified_at
  ) values
    ('20000000-0000-4000-8000-000000000001', v_user, 101, 'project-user',
     'connected', statement_timestamp(), statement_timestamp()),
    ('20000000-0000-4000-8000-000000000002', v_peer, 102, 'project-peer',
     'connected', statement_timestamp(), statement_timestamp());

  insert into public.repository_projects (
    project_id, github_repository_id, repository_full_name, visibility,
    default_branch, status
  ) values
    ('30000000-0000-4000-8000-000000000010', 10, 'scope/project-10', 'private', 'main', 'active'),
    ('30000000-0000-4000-8000-000000000020', 20, 'scope/project-20', 'public', 'trunk', 'active'),
    ('30000000-0000-4000-8000-000000000030', 30, 'scope/project-30', 'internal', 'main', 'archived'),
    ('30000000-0000-4000-8000-000000000040', 40, 'peer/private-project', 'private', 'main', 'active');

  insert into public.github_repository_access (
    user_id, github_connection_id, github_repository_id, status, verified_at,
    revoked_at
  ) values
    (v_user, '20000000-0000-4000-8000-000000000001', 10, 'verified', statement_timestamp(), null),
    (v_user, '20000000-0000-4000-8000-000000000001', 20, 'revalidation_required', statement_timestamp(), null),
    (v_user, '20000000-0000-4000-8000-000000000001', 30, 'revoked', statement_timestamp(), statement_timestamp()),
    (v_peer, '20000000-0000-4000-8000-000000000002', 10, 'verified', statement_timestamp(), null),
    (v_peer, '20000000-0000-4000-8000-000000000002', 40, 'verified', statement_timestamp(), null);

  insert into public.project_memberships (
    project_id, user_id, status, revoked_at
  ) values
    ('30000000-0000-4000-8000-000000000010', v_user, 'active', null),
    ('30000000-0000-4000-8000-000000000020', v_user, 'suspended', null),
    ('30000000-0000-4000-8000-000000000030', v_user, 'revoked', statement_timestamp()),
    ('30000000-0000-4000-8000-000000000010', v_peer, 'active', null),
    ('30000000-0000-4000-8000-000000000040', v_peer, 'active', null);

  insert into public.runtime_bindings (
    runtime_binding_id, user_id, project_id, github_repository_id, status,
    connector_instance_id, current_branch, commit_sha,
    repository_permission, last_verified_at, last_seen_at,
    unavailable_reason, unavailable_at
  ) values
    ('40000000-0000-4000-8000-000000000010', v_user,
     '30000000-0000-4000-8000-000000000010', 10, 'ready',
     'connector_project_user_10', 'main', repeat('a', 40), 'write',
     statement_timestamp(), statement_timestamp(), null, null),
    ('40000000-0000-4000-8000-000000000020', v_user,
     '30000000-0000-4000-8000-000000000020', 20, 'unavailable',
     'connector_project_user_20', 'trunk', repeat('b', 40), 'read',
     statement_timestamp(), statement_timestamp(), 'repository_access_lost',
     statement_timestamp()),
    ('40000000-0000-4000-8000-000000000030', v_user,
     '30000000-0000-4000-8000-000000000030', 30, 'revoked',
     'connector_project_user_30', 'main', repeat('c', 40), 'admin',
     statement_timestamp(), statement_timestamp(), null, null),
    ('40000000-0000-4000-8000-000000000011', v_peer,
     '30000000-0000-4000-8000-000000000010', 10, 'ready',
     'connector_project_peer_10', 'main', repeat('d', 40), 'read',
     statement_timestamp(), statement_timestamp(), null, null),
    ('40000000-0000-4000-8000-000000000040', v_peer,
     '30000000-0000-4000-8000-000000000040', 40, 'ready',
     'connector_project_peer_40', 'main', repeat('e', 40), 'admin',
     statement_timestamp(), statement_timestamp(), null, null);

  insert into public.project_connections (
    project_connection_id, project_id, requester_user_id, recipient_user_id,
    status, requested_at, accepted_at
  ) values (
    '50000000-0000-4000-8000-000000000010',
    '30000000-0000-4000-8000-000000000010', v_user, v_peer,
    'connected', statement_timestamp(), statement_timestamp()
  );

  v_page := public.list_user_projects(v_user, null, 2);
  if jsonb_array_length(v_page) <> 2 or
     v_page #>> '{0,githubRepositoryId}' <> '10' or
     v_page #>> '{1,githubRepositoryId}' <> '20' or
     v_page #>> '{0,connectedCollaboratorCount}' <> '1' or
     v_page #>> '{1,repositoryAccessStatus}' <> 'revalidation_required' or
     v_page #>> '{1,membershipStatus}' <> 'suspended' or
     v_page #>> '{1,binding,status}' <> 'unavailable' then
    raise exception 'T1 FAILED: first owner page was invalid %', v_page;
  end if;

  v_page := public.list_user_projects(v_user, 20, 2);
  if jsonb_array_length(v_page) <> 1 or
     v_page #>> '{0,githubRepositoryId}' <> '30' or
     v_page #>> '{0,projectStatus}' <> 'archived' or
     v_page #>> '{0,membershipStatus}' <> 'revoked' then
    raise exception 'T2 FAILED: keyset continuation was invalid %', v_page;
  end if;

  v_page := public.list_user_projects(v_user, null, 51);
  if v_page::text like '%peer/private-project%' or
     v_page::text like '%connector_project_peer_40%' then
    raise exception 'T3 FAILED: another user project leaked %', v_page;
  end if;
  if v_page::text ~* '(workspace|token|credential|remoteUrl|providerSession)' then
    raise exception 'T3 FAILED: a forbidden field entered discovery %', v_page;
  end if;

  if public.list_user_projects(v_user, null, 52) is not null or
     public.list_user_projects(v_user, 0, 20) is not null or
     public.list_user_projects(
       '10000000-0000-4000-8000-000000000099', null, 20
     ) is not null then
    raise exception 'T4 FAILED: invalid scope or bounds did not fail closed';
  end if;

  if has_function_privilege(
    'anon', 'public.list_user_projects(uuid,bigint,integer)', 'EXECUTE'
  ) or has_function_privilege(
    'authenticated', 'public.list_user_projects(uuid,bigint,integer)', 'EXECUTE'
  ) then
    raise exception 'T5 FAILED: browser roles can execute project discovery';
  end if;
end;
$$;

rollback;
