-- Transactional lifecycle, ACL, and privacy tests for project connections and
-- conversation creation.
begin;

do $$
declare
  -- alice and bob both prove access to repository 10 and become eligible.
  v_alice    uuid := '10000000-0000-4000-8000-00000000a001';
  v_bob      uuid := '10000000-0000-4000-8000-00000000b002';
  -- carol is a member of the same project but her access proof went stale, so
  -- neither side may see or reach her.
  v_carol    uuid := '10000000-0000-4000-8000-00000000c003';
  -- dave belongs to a different project entirely.
  v_dave     uuid := '10000000-0000-4000-8000-00000000d004';
  v_project  uuid := '30000000-0000-4000-8000-0000000000aa';
  v_other    uuid := '30000000-0000-4000-8000-0000000000bb';
  v_conn     uuid := '50000000-0000-4000-8000-000000000001';
  v_conn_alt uuid := '50000000-0000-4000-8000-000000000002';
  v_convo    uuid := '60000000-0000-4000-8000-000000000001';
  v_convo_2  uuid := '60000000-0000-4000-8000-000000000002';
  v_page     jsonb;
  v_row      jsonb;
  v_count    integer;
begin
  insert into public.user_accounts (user_id, status) values
    (v_alice, 'active'),
    (v_bob,   'active'),
    (v_carol, 'active'),
    (v_dave,  'active');

  insert into public.github_connections (
    github_connection_id, user_id, github_user_id, github_login, status,
    connected_at, last_verified_at
  ) values
    ('20000000-0000-4000-8000-00000000a001', v_alice, 901, 'alice-gh',
     'connected', statement_timestamp(), statement_timestamp()),
    ('20000000-0000-4000-8000-00000000b002', v_bob,   902, 'bob-gh',
     'connected', statement_timestamp(), statement_timestamp()),
    ('20000000-0000-4000-8000-00000000c003', v_carol, 903, 'carol-gh',
     'connected', statement_timestamp(), statement_timestamp()),
    ('20000000-0000-4000-8000-00000000d004', v_dave,  904, 'dave-gh',
     'connected', statement_timestamp(), statement_timestamp());

  insert into public.repository_projects (
    project_id, github_repository_id, repository_full_name, visibility,
    default_branch, status
  ) values
    (v_project, 910, 'scope/connections-repo', 'private', 'main', 'active'),
    (v_other,   920, 'scope/other-repo',       'private', 'main', 'active');

  insert into public.github_repository_access (
    user_id, github_connection_id, github_repository_id, status, verified_at,
    revoked_at
  ) values
    (v_alice, '20000000-0000-4000-8000-00000000a001', 910, 'verified',
     statement_timestamp(), null),
    (v_bob,   '20000000-0000-4000-8000-00000000b002', 910, 'verified',
     statement_timestamp(), null),
    -- carol is a member but has not re-proved access.
    (v_carol, '20000000-0000-4000-8000-00000000c003', 910,
     'revalidation_required', statement_timestamp(), null),
    (v_dave,  '20000000-0000-4000-8000-00000000d004', 920, 'verified',
     statement_timestamp(), null);

  insert into public.project_memberships (
    project_id, user_id, status, revoked_at
  ) values
    (v_project, v_alice, 'active', null),
    (v_project, v_bob,   'active', null),
    (v_project, v_carol, 'active', null),
    (v_other,   v_dave,  'active', null);

  -- T1: discovery lists only peers who independently proved access.
  v_page := public.list_project_collaborators(v_alice, v_project, 51);
  if jsonb_array_length(v_page) <> 1 or
     v_page #>> '{0,userId}' <> v_bob::text or
     v_page #>> '{0,githubLogin}' <> 'bob-gh' or
     v_page #>> '{0,connectionStatus}' <> 'none' or
     v_page #>> '{0,projectConnectionId}' is not null then
    raise exception 'T1 FAILED: eligible peer listing was invalid %', v_page;
  end if;

  -- T2: discovery carries identity and connection state only.
  if v_page::text ~* '(workspace|token|credential|remoteUrl|providerSession|repositoryFullName|defaultBranch)' or
     v_page::text like '%scope/connections-repo%' then
    raise exception 'T2 FAILED: a forbidden field entered discovery %', v_page;
  end if;

  -- T3: bounds and caller scope fail closed.
  if public.list_project_collaborators(v_alice, v_project, 0) is not null or
     public.list_project_collaborators(v_alice, v_project, 52) is not null or
     public.list_project_collaborators(v_alice, v_project, null) is not null or
     -- carol's own proof is stale, so she may not enumerate the project.
     public.list_project_collaborators(v_carol, v_project, 10) is not null or
     -- dave is a member of a different project; repo A never authorizes repo B.
     public.list_project_collaborators(v_dave, v_project, 10) is not null then
    raise exception 'T3 FAILED: invalid bounds or scope did not fail closed';
  end if;

  -- T4: an ineligible pair cannot be requested at all.
  if public.request_project_connection(
       v_conn, v_project, v_alice, v_carol, statement_timestamp()
     ) is not null or
     public.request_project_connection(
       v_conn, v_project, v_alice, v_dave, statement_timestamp()
     ) is not null or
     public.request_project_connection(
       v_conn, v_project, v_alice, v_alice, statement_timestamp()
     ) is not null then
    raise exception 'T4 FAILED: an ineligible pair was allowed to connect';
  end if;

  -- T5: a first request opens a pending row.
  v_row := public.request_project_connection(
    v_conn, v_project, v_alice, v_bob, statement_timestamp()
  );
  if v_row ->> 'projectConnectionId' <> v_conn::text or
     v_row ->> 'status' <> 'pending' or
     v_row ->> 'requesterUserId' <> v_alice::text or
     v_row ->> 'recipientUserId' <> v_bob::text or
     v_row ->> 'requestedAt' is null or
     v_row ->> 'acceptedAt' is not null or
     v_row ->> 'revokedAt' is not null then
    raise exception 'T5 FAILED: request did not open a pending row %', v_row;
  end if;

  -- T6: a pending pair is not requestable again, in either direction.
  if public.request_project_connection(
       v_conn_alt, v_project, v_alice, v_bob, statement_timestamp()
     ) is not null or
     public.request_project_connection(
       v_conn_alt, v_project, v_bob, v_alice, statement_timestamp()
     ) is not null then
    raise exception 'T6 FAILED: a pending pair was re-requested';
  end if;

  -- T7: each side sees the pending request from its own direction.
  if public.list_project_collaborators(v_alice, v_project, 51)
       #>> '{0,connectionStatus}' <> 'pending_outgoing' or
     public.list_project_collaborators(v_bob, v_project, 51)
       #>> '{0,connectionStatus}' <> 'pending_incoming' or
     public.list_project_collaborators(v_bob, v_project, 51)
       #>> '{0,projectConnectionId}' <> v_conn::text then
    raise exception 'T7 FAILED: pending direction was not reported per viewer';
  end if;

  -- T8: only the named recipient may answer, and only with a real decision.
  if public.respond_to_project_connection(
       v_conn, v_alice, 'accept', statement_timestamp()
     ) is not null or
     public.respond_to_project_connection(
       v_conn, v_carol, 'accept', statement_timestamp()
     ) is not null or
     public.respond_to_project_connection(
       v_conn, v_bob, 'maybe', statement_timestamp()
     ) is not null then
    raise exception 'T8 FAILED: an unauthorized response was accepted';
  end if;

  -- T9: the recipient accepts.
  v_row := public.respond_to_project_connection(
    v_conn, v_bob, 'accept', statement_timestamp()
  );
  if v_row ->> 'status' <> 'connected' or
     v_row ->> 'acceptedAt' is null or
     v_row ->> 'revokedAt' is not null then
    raise exception 'T9 FAILED: accept did not connect the pair %', v_row;
  end if;
  if public.respond_to_project_connection(
       v_conn, v_bob, 'accept', statement_timestamp()
     ) is not null then
    raise exception 'T9 FAILED: a settled connection was answered twice';
  end if;

  -- T10: a conversation opens for the connected pair.
  v_row := public.create_project_conversation(v_convo, v_project, v_alice, v_bob);
  if v_row ->> 'conversationId' <> v_convo::text or
     v_row ->> 'projectId' <> v_project::text or
     v_row ->> 'githubRepositoryId' <> '910' or
     v_row ->> 'status' <> 'active' or
     (v_row ->> 'created')::boolean is not true then
    raise exception 'T10 FAILED: conversation was not opened %', v_row;
  end if;
  select count(*) into v_count
  from public.conversation_participants
  where conversation_id = v_convo;
  if v_count <> 2 then
    raise exception 'T10 FAILED: expected two participants, found %', v_count;
  end if;

  -- T11: opening again returns the conversation already open, from either
  -- side, rather than fragmenting the pair across duplicates.
  v_row := public.create_project_conversation(v_convo_2, v_project, v_bob, v_alice);
  if v_row ->> 'conversationId' <> v_convo::text or
     (v_row ->> 'created')::boolean is not false then
    raise exception 'T11 FAILED: creation was not idempotent %', v_row;
  end if;
  select count(*) into v_count from public.project_conversations;
  if v_count <> 1 then
    raise exception 'T11 FAILED: expected one conversation, found %', v_count;
  end if;

  -- T12: unconnected, self, and cross-repository pairs open nothing.
  if public.create_project_conversation(v_convo_2, v_project, v_alice, v_carol) is not null or
     public.create_project_conversation(v_convo_2, v_project, v_alice, v_dave) is not null or
     public.create_project_conversation(v_convo_2, v_project, v_alice, v_alice) is not null or
     public.create_project_conversation(v_convo_2, v_other, v_alice, v_bob) is not null then
    raise exception 'T12 FAILED: a conversation opened without a connection';
  end if;

  -- T13: either side may revoke, and a third party may not.
  if public.revoke_project_connection(
       v_conn, v_carol, statement_timestamp()
     ) is not null then
    raise exception 'T13 FAILED: a third party revoked a connection';
  end if;
  v_row := public.revoke_project_connection(v_conn, v_bob, statement_timestamp());
  if v_row ->> 'status' <> 'revoked' or v_row ->> 'revokedAt' is null then
    raise exception 'T13 FAILED: revoke did not settle the row %', v_row;
  end if;
  if public.revoke_project_connection(
       v_conn, v_bob, statement_timestamp()
     ) is not null then
    raise exception 'T13 FAILED: an already revoked row was revoked again';
  end if;

  -- T14: revocation stops new conversations immediately. The existing
  -- conversation row survives; what stops is new cross-agent work.
  if public.create_project_conversation(v_convo_2, v_project, v_alice, v_bob) is not null then
    raise exception 'T14 FAILED: a revoked pair opened a conversation';
  end if;
  select count(*) into v_count from public.project_conversations;
  if v_count <> 1 then
    raise exception 'T14 FAILED: revocation deleted conversation history';
  end if;

  -- T15: a revoked pair may be asked again, reusing the one durable row.
  v_row := public.request_project_connection(
    v_conn_alt, v_project, v_bob, v_alice, statement_timestamp()
  );
  if v_row ->> 'projectConnectionId' <> v_conn::text or
     v_row ->> 'status' <> 'pending' or
     v_row ->> 'requesterUserId' <> v_bob::text or
     v_row ->> 'recipientUserId' <> v_alice::text or
     v_row ->> 'acceptedAt' is not null or
     v_row ->> 'revokedAt' is not null then
    raise exception 'T15 FAILED: re-request did not reuse the pair row %', v_row;
  end if;
  select count(*) into v_count from public.project_connections;
  if v_count <> 1 then
    raise exception 'T15 FAILED: expected one pair row, found %', v_count;
  end if;

  -- T16: declining settles as revoked, not connected.
  v_row := public.respond_to_project_connection(
    v_conn, v_alice, 'decline', statement_timestamp()
  );
  if v_row ->> 'status' <> 'revoked' or
     v_row ->> 'revokedAt' is null or
     v_row ->> 'acceptedAt' is not null then
    raise exception 'T16 FAILED: decline did not settle the row %', v_row;
  end if;
  if public.list_project_collaborators(v_alice, v_project, 51)
       #>> '{0,connectionStatus}' <> 'revoked' then
    raise exception 'T16 FAILED: a declined pair was not reported as revoked';
  end if;

  -- T17: accepting re-checks mutual proof. A request that sat while a side
  -- lost repository access must not silently become a live connection.
  update public.project_connections
  set status = 'pending', accepted_at = null, revoked_at = null
  where project_connection_id = v_conn;
  update public.github_repository_access
  set status = 'revalidation_required', revoked_at = null
  where user_id = v_bob and github_repository_id = 910;
  if public.respond_to_project_connection(
       v_conn, v_alice, 'accept', statement_timestamp()
     ) is not null then
    raise exception 'T17 FAILED: accept ignored lost repository access';
  end if;
  -- Declining is always safe, even without a live proof.
  if public.respond_to_project_connection(
       v_conn, v_alice, 'decline', statement_timestamp()
     ) is null then
    raise exception 'T17 FAILED: decline required a live access proof';
  end if;

  -- T18: no browser role may execute any of these.
  if has_function_privilege(
       'anon', 'public.list_project_collaborators(uuid,uuid,integer)', 'EXECUTE'
     ) or has_function_privilege(
       'authenticated', 'public.list_project_collaborators(uuid,uuid,integer)', 'EXECUTE'
     ) or has_function_privilege(
       'anon', 'public.request_project_connection(uuid,uuid,uuid,uuid,timestamptz)', 'EXECUTE'
     ) or has_function_privilege(
       'authenticated', 'public.request_project_connection(uuid,uuid,uuid,uuid,timestamptz)', 'EXECUTE'
     ) or has_function_privilege(
       'anon', 'public.respond_to_project_connection(uuid,uuid,text,timestamptz)', 'EXECUTE'
     ) or has_function_privilege(
       'authenticated', 'public.respond_to_project_connection(uuid,uuid,text,timestamptz)', 'EXECUTE'
     ) or has_function_privilege(
       'anon', 'public.revoke_project_connection(uuid,uuid,timestamptz)', 'EXECUTE'
     ) or has_function_privilege(
       'authenticated', 'public.revoke_project_connection(uuid,uuid,timestamptz)', 'EXECUTE'
     ) or has_function_privilege(
       'anon', 'public.create_project_conversation(uuid,uuid,uuid,uuid)', 'EXECUTE'
     ) or has_function_privilege(
       'authenticated', 'public.create_project_conversation(uuid,uuid,uuid,uuid)', 'EXECUTE'
     ) then
    raise exception 'T18 FAILED: browser roles can execute connection writes';
  end if;
end;
$$;

rollback;
