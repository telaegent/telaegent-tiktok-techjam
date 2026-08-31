-- Transactional contract/security tests for dedicated connector credentials.
begin;

do $$
declare
  v_user uuid := '10000000-0000-4000-8000-000000000001';
  v_instance text := 'connector_instance_0001';
  v_first_hash text := repeat('a', 64);
  v_second_hash text := repeat('b', 64);
  v_principal jsonb;
  v_first_seen timestamptz;
  v_throttled_seen timestamptz;
  v_project uuid := '20000000-0000-4000-8000-000000000002';
  v_connection uuid := '30000000-0000-4000-8000-000000000003';
  v_binding uuid := '40000000-0000-4000-8000-000000000004';
  v_status jsonb;
begin
  insert into public.user_accounts (user_id, status) values (v_user, 'active');

  if not public.create_connector_credential(
    v_user, v_instance, v_first_hash, 3600
  ) then
    raise exception 'T1 FAILED: active account could not create a connector credential';
  end if;
  v_principal := public.authenticate_connector_credential(v_first_hash);
  if v_principal <> jsonb_build_object(
    'authenticatedUserId', v_user::text,
    'connectorInstanceId', v_instance
  ) then
    raise exception 'T2 FAILED: credential did not resolve its bound principal %', v_principal;
  end if;
  if not exists (
    select 1 from public.connector_credentials credential
    where credential.user_id = v_user
      and credential.connector_instance_id = v_instance
      and credential.token_hash = decode(v_first_hash, 'hex')
      and credential.last_seen_at is not null
  ) then
    raise exception 'T2 FAILED: authentication did not update safe presence';
  end if;

  select credential.last_seen_at into v_first_seen
  from public.connector_credentials credential
  where credential.token_hash = decode(v_first_hash, 'hex');
  perform public.authenticate_connector_credential(v_first_hash);
  select credential.last_seen_at into v_throttled_seen
  from public.connector_credentials credential
  where credential.token_hash = decode(v_first_hash, 'hex');
  if v_throttled_seen is distinct from v_first_seen then
    raise exception 'T2 FAILED: presence was rewritten inside throttle window';
  end if;

  update public.connector_credentials
    set last_seen_at = statement_timestamp() - interval '31 seconds'
  where token_hash = decode(v_first_hash, 'hex');
  select credential.last_seen_at into v_first_seen
  from public.connector_credentials credential
  where credential.token_hash = decode(v_first_hash, 'hex');
  perform public.authenticate_connector_credential(v_first_hash);
  select credential.last_seen_at into v_throttled_seen
  from public.connector_credentials credential
  where credential.token_hash = decode(v_first_hash, 'hex');
  if v_throttled_seen <= v_first_seen then
    raise exception 'T2 FAILED: stale presence was not refreshed';
  end if;

  insert into public.github_connections (
    github_connection_id, user_id, github_user_id, github_login, status,
    last_verified_at
  ) values (
    v_connection, v_user, 123456789, 'credential-test-user', 'connected',
    statement_timestamp()
  );
  insert into public.github_repository_access (
    user_id, github_connection_id, github_repository_id, status, verified_at
  ) values (
    v_user, v_connection, 987654321, 'verified', statement_timestamp()
  );
  insert into public.repository_projects (
    project_id, github_repository_id, repository_full_name, visibility,
    default_branch, status
  ) values (
    v_project, 987654321, 'telaegent/status-contract', 'private', 'main', 'active'
  );
  insert into public.project_memberships (project_id, user_id, status)
  values (v_project, v_user, 'active');
  insert into public.runtime_bindings (
    runtime_binding_id, user_id, project_id, github_repository_id, status,
    connector_instance_id, current_branch, commit_sha,
    repository_permission, last_verified_at, last_seen_at
  ) values (
    v_binding, v_user, v_project, 987654321, 'ready', v_instance, 'main',
    repeat('a', 40), 'write', statement_timestamp(), statement_timestamp()
  );

  v_status := public.load_connector_setup_status(v_user, v_instance, 25);
  if v_status is null or
     v_status ->> 'connectorInstanceId' <> v_instance or
     v_status #>> '{credential,status}' <> 'active' or
     jsonb_array_length(v_status -> 'bindings') <> 1 or
     v_status #>> '{bindings,0,connectorBindingId}' <> v_binding::text or
     v_status #>> '{bindings,0,githubRepositoryId}' <> '987654321' or
     v_status #>> '{bindings,0,repositoryFullName}' <> 'telaegent/status-contract' or
     (v_status ->> 'bindingsTruncated')::boolean then
    raise exception 'T3 FAILED: owner setup status was invalid %', v_status;
  end if;
  if v_status::text ~* '(token|hash|workspace|credentialId)' then
    raise exception 'T3 FAILED: setup status exposed a forbidden field %', v_status;
  end if;
  if public.load_connector_setup_status(
    '10000000-0000-4000-8000-000000000099', v_instance, 25
  ) is not null then
    raise exception 'T3 FAILED: another user resolved connector setup status';
  end if;
  if public.load_connector_setup_status(v_user, v_instance, 26) is not null then
    raise exception 'T3 FAILED: out-of-range binding limit did not fail closed';
  end if;

  if not public.create_connector_credential(
    v_user, v_instance, v_second_hash, 3600
  ) then
    raise exception 'T4 FAILED: credential rotation failed';
  end if;
  if public.authenticate_connector_credential(v_first_hash) is not null then
    raise exception 'T4 FAILED: rotated credential remained active';
  end if;
  if public.authenticate_connector_credential(v_second_hash) is null then
    raise exception 'T4 FAILED: replacement credential was not active';
  end if;

  if not public.revoke_connector_credential(v_user, v_instance) then
    raise exception 'T5 FAILED: active credential was not revoked';
  end if;
  if public.authenticate_connector_credential(v_second_hash) is not null then
    raise exception 'T5 FAILED: revoked credential remained usable';
  end if;

  update public.user_accounts set status = 'disabled' where user_id = v_user;
  if public.create_connector_credential(
    v_user, v_instance, repeat('c', 64), 3600
  ) then
    raise exception 'T6 FAILED: disabled account created a connector credential';
  end if;

  if has_function_privilege(
    'anon', 'public.authenticate_connector_credential(text)', 'EXECUTE'
  ) or has_function_privilege(
    'authenticated', 'public.authenticate_connector_credential(text)', 'EXECUTE'
  ) then
    raise exception 'T7 FAILED: browser roles can authenticate connector credentials';
  end if;
  if has_function_privilege(
    'anon', 'public.load_connector_setup_status(uuid,text,integer)', 'EXECUTE'
  ) or has_function_privilege(
    'authenticated', 'public.load_connector_setup_status(uuid,text,integer)', 'EXECUTE'
  ) then
    raise exception 'T7 FAILED: browser roles can load connector setup status';
  end if;
end;
$$;

rollback;
