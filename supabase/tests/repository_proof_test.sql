-- Transactional contract/security tests for local repository proof persistence.
-- Run after all migrations. This script leaves no rows behind.
begin;

do $$
declare
  v_user uuid := '10000000-0000-4000-8000-000000000001';
  v_proof uuid := '20000000-0000-4000-8000-000000000002';
  v_repo bigint := 9223372036854775807;
  v_connector text := 'connector_instance_0001';
  v_observed timestamptz := statement_timestamp();
  v_result jsonb;
  v_binding uuid;
  v_connection uuid;
  v_project uuid;
  v_count integer;
begin
  insert into public.user_accounts (user_id, status) values (v_user, 'active');
  insert into public.account_github_identities (
    user_id, github_user_id, github_login
  ) values (v_user, 123456789, 'khoa-dao');

  v_result := public.register_local_github_repository_proof(
    v_user, v_connector, v_proof, repeat('a', 64), v_observed,
    123456789, 'khoa-dao', v_repo, 'Telaegent/codejam.repo',
    'private', 'main', 'khoa.dao', repeat('b', 40), 'write'
  );
  if v_result ->> 'replayed' <> 'false' or
     v_result ->> 'githubRepositoryId' <> v_repo::text or
     v_result ->> 'bindingStatus' <> 'ready' then
    raise exception 'T1 FAILED: first registration result %', v_result;
  end if;
  v_binding := (v_result ->> 'connectorBindingId')::uuid;
  v_connection := (v_result ->> 'githubConnectionId')::uuid;
  v_project := (v_result ->> 'projectId')::uuid;

  if not exists (
    select 1 from public.runtime_bindings binding
    where binding.runtime_binding_id = v_binding
      and binding.user_id = v_user
      and binding.github_repository_id = v_repo
      and binding.connector_instance_id = v_connector
      and binding.status = 'ready'
      and binding.current_branch = 'khoa.dao'
      and binding.commit_sha = repeat('b', 40)
  ) then
    raise exception 'T2 FAILED: path-free connector binding was not persisted';
  end if;

  -- Same proof ID + principal + digest is idempotent.
  v_result := public.register_local_github_repository_proof(
    v_user, v_connector, v_proof, repeat('a', 64), v_observed,
    123456789, 'khoa-dao', v_repo, 'Telaegent/codejam.repo',
    'private', 'main', 'khoa.dao', repeat('b', 40), 'write'
  );
  if v_result ->> 'replayed' <> 'true' or
     (v_result ->> 'connectorBindingId')::uuid <> v_binding then
    raise exception 'T3 FAILED: safe retry did not replay %', v_result;
  end if;

  v_result := public.register_local_github_repository_proof(
    v_user, v_connector, v_proof, repeat('c', 64), v_observed,
    123456789, 'khoa-dao', v_repo, 'Telaegent/codejam.repo',
    'private', 'main', 'khoa.dao', repeat('b', 40), 'write'
  );
  if v_result <> '{"error":"proof_id_conflict"}'::jsonb then
    raise exception 'T4 FAILED: proof ID reuse was not rejected %', v_result;
  end if;

  -- Website identity and local gh identity must be the same stable GitHub ID.
  v_result := public.register_local_github_repository_proof(
    v_user, v_connector, '20000000-0000-4000-8000-000000000003', repeat('d', 64), v_observed,
    999999999, 'attacker', 777, 'attacker/other',
    'public', 'main', 'main', repeat('d', 40), 'admin'
  );
  if v_result <> '{"error":"github_identity_mismatch"}'::jsonb then
    raise exception 'T5 FAILED: GitHub identity mismatch was not rejected %', v_result;
  end if;
  select count(*) into v_count from public.repository_projects
  where github_repository_id = 777;
  if v_count <> 0 then
    raise exception 'T5 FAILED: rejected identity partially created a project';
  end if;

  -- An explicit revocation is sticky. Rejected proof must not partially update
  -- connection or project metadata before discovering that revocation.
  update public.github_repository_access
    set status = 'revoked', revoked_at = clock_timestamp()
  where user_id = v_user and github_repository_id = v_repo;
  v_result := public.register_local_github_repository_proof(
    v_user, v_connector, '20000000-0000-4000-8000-000000000004', repeat('e', 64), v_observed,
    123456789, 'changed-login', v_repo, 'Changed/changed-name',
    'public', 'changed-default', 'changed-current', repeat('e', 40), 'admin'
  );
  if v_result <> '{"error":"repository_access_revoked"}'::jsonb then
    raise exception 'T6 FAILED: revoked access was reactivated %', v_result;
  end if;
  if (select github_login from public.github_connections
      where github_connection_id = v_connection) <> 'khoa-dao' or
     (select repository_full_name from public.repository_projects
      where project_id = v_project) <> 'Telaegent/codejam.repo' then
    raise exception 'T6 FAILED: rejected proof partially mutated durable state';
  end if;
  update public.github_repository_access
    set status = 'verified', revoked_at = null
  where user_id = v_user and github_repository_id = v_repo;

  -- Another connector installation cannot suspend this binding.
  v_result := public.mark_local_github_repository_unavailable(
    v_user, 'connector_instance_9999', v_repo, v_observed,
    'repository_access_lost'
  );
  if v_result <> '{"error":"binding_not_owned"}'::jsonb then
    raise exception 'T7 FAILED: cross-connector event was accepted %', v_result;
  end if;
  if (select status from public.runtime_bindings
      where runtime_binding_id = v_binding) <> 'ready' then
    raise exception 'T7 FAILED: cross-connector event changed binding';
  end if;

  v_result := public.mark_local_github_repository_unavailable(
    v_user, v_connector, v_repo, v_observed, 'repository_access_lost'
  );
  if v_result ->> 'accessStatus' <> 'revalidation_required' or
     v_result ->> 'membershipStatus' <> 'suspended' or
     v_result ->> 'bindingStatus' <> 'unavailable' or
     v_result ->> 'changed' <> 'true' then
    raise exception 'T8 FAILED: loss did not suspend the exact scope %', v_result;
  end if;

  -- A historical replay must not claim ready after the binding became unavailable.
  v_result := public.register_local_github_repository_proof(
    v_user, v_connector, v_proof, repeat('a', 64), v_observed,
    123456789, 'khoa-dao', v_repo, 'Telaegent/codejam.repo',
    'private', 'main', 'khoa.dao', repeat('b', 40), 'write'
  );
  if v_result <> '{"error":"proof_id_conflict"}'::jsonb then
    raise exception 'T9 FAILED: stale replay claimed current readiness %', v_result;
  end if;

  -- A new successful local proof may recover unavailable/suspended state while
  -- preserving the opaque binding ID.
  v_result := public.register_local_github_repository_proof(
    v_user, v_connector, '20000000-0000-4000-8000-000000000005', repeat('f', 64), v_observed,
    123456789, 'khoa-dao', v_repo, 'Telaegent/codejam.repo',
    'private', 'main', 'khoa.dao', repeat('f', 40), 'write'
  );
  if v_result ->> 'bindingStatus' <> 'ready' or
     (v_result ->> 'connectorBindingId')::uuid <> v_binding or
     (select status from public.project_memberships
       where project_id = v_project and user_id = v_user) <> 'active' then
    raise exception 'T10 FAILED: fresh proof did not recover binding %', v_result;
  end if;

  -- A stale loss event cannot undo a later successful proof.
  v_result := public.mark_local_github_repository_unavailable(
    v_user, v_connector, v_repo, v_observed - interval '1 second',
    'repository_access_lost'
  );
  if v_result <> '{"error":"stale_observation"}'::jsonb or
     (select status from public.runtime_bindings
      where runtime_binding_id = v_binding) <> 'ready' then
    raise exception 'T11 FAILED: stale loss event changed current state %', v_result;
  end if;

  -- Browser roles can neither inspect proof rows nor invoke the RPCs.
  if has_table_privilege('anon', 'public.repository_registration_proofs', 'select') or
     has_table_privilege('authenticated', 'public.repository_registration_proofs', 'select') or
     has_function_privilege(
       'anon',
       'public.register_local_github_repository_proof(uuid,text,uuid,text,timestamptz,bigint,text,bigint,text,text,text,text,text,text)',
       'execute'
     ) or
     not has_function_privilege(
       'service_role',
       'public.register_local_github_repository_proof(uuid,text,uuid,text,timestamptz,bigint,text,bigint,text,text,text,text,text,text)',
       'execute'
     ) then
    raise exception 'T12 FAILED: repository proof ACL is unsafe';
  end if;
end;
$$;

rollback;

