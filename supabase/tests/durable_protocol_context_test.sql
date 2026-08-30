-- Durable sender context must be reconstructible without provider state.
begin;

do $$
declare
  v_owner uuid := '10000000-0000-4000-8000-000000000001';
  v_peer uuid := '10000000-0000-4000-8000-000000000002';
  v_project uuid := '20000000-0000-4000-8000-000000000002';
  v_conversation uuid := '30000000-0000-4000-8000-000000000003';
  v_binding uuid := '40000000-0000-4000-8000-000000000004';
  v_draft uuid := '50000000-0000-4000-8000-000000000005';
  v_message uuid := '60000000-0000-4000-8000-000000000006';
  v_repo bigint := 9223372036854775807;
  v_context jsonb;
begin
  insert into public.user_accounts (user_id, status)
  values (v_owner, 'active'), (v_peer, 'active');
  insert into public.account_github_identities (
    user_id, github_user_id, github_login
  ) values
    (v_owner, 111111111, 'phuong'),
    (v_peer, 222222222, 'justin');
  insert into public.repository_projects (
    project_id, github_repository_id, repository_full_name,
    visibility, default_branch, status
  ) values (
    v_project, v_repo, 'Telaegent/secret', 'private', 'main', 'active'
  );
  insert into public.project_memberships (project_id, user_id, status)
  values (v_project, v_owner, 'active'), (v_project, v_peer, 'active');
  insert into public.project_conversations (conversation_id, project_id, status)
  values (v_conversation, v_project, 'active');
  insert into public.conversation_participants (
    conversation_id, project_id, user_id
  ) values
    (v_conversation, v_project, v_owner),
    (v_conversation, v_project, v_peer);
  insert into public.runtime_bindings (
    runtime_binding_id, user_id, project_id, github_repository_id, status,
    connector_instance_id, current_branch, commit_sha,
    repository_permission, last_verified_at, last_seen_at
  ) values (
    v_binding, v_owner, v_project, v_repo, 'ready',
    'connector_instance_0001', 'feature/relay', repeat('a', 40),
    'write', statement_timestamp(), statement_timestamp()
  );
  insert into public.private_drafts (
    draft_id, conversation_id, github_repository_id, owner_user_id,
    provider, rough_message, state, created_at, updated_at
  ) values (
    v_draft, v_conversation, v_repo, v_owner,
    'claude', 'Tell Justin the relay works', 'created',
    statement_timestamp(), statement_timestamp()
  );
  insert into public.shared_messages (
    message_id, conversation_id, github_repository_id, sender_user_id,
    body, origin, provider, sent_at
  ) values (
    v_message, v_conversation, v_repo, v_peer,
    'Use the approved transport contract.', 'agent', 'codex',
    statement_timestamp() - interval '1 minute'
  );

  v_context := public.load_sender_protocol_context(
    v_owner, v_repo, v_conversation, v_draft, 200
  );
  if v_context->>'role' <> 'sender' or
     v_context->>'ownerInput' <> 'Tell Justin the relay works' or
     v_context#>>'{facts,githubRepositoryId}' <> v_repo::text or
     v_context#>>'{facts,branch}' <> 'feature/relay' or
     v_context#>>'{facts,commit}' <> repeat('a', 40) or
     v_context#>>'{facts,ownerName}' <> 'phuong' or
     v_context#>>'{facts,collaboratorName}' <> 'justin' or
     jsonb_array_length(v_context->'sharedHistory') <> 1 then
    raise exception 'T1 FAILED: durable protocol context was incomplete %', v_context;
  end if;
  if v_context::text ~* '(workspace|credential|sessionId|providerHome)' then
    raise exception 'T2 FAILED: private infrastructure leaked into context';
  end if;
  if public.load_sender_protocol_context(
    v_peer, v_repo, v_conversation, v_draft, 200
  ) is not null then
    raise exception 'T3 FAILED: another user loaded the owner private draft';
  end if;
  if has_function_privilege(
    'anon', 'public.load_sender_protocol_context(uuid,bigint,uuid,uuid,integer)', 'EXECUTE'
  ) or has_function_privilege(
    'authenticated', 'public.load_sender_protocol_context(uuid,bigint,uuid,uuid,integer)', 'EXECUTE'
  ) then
    raise exception 'T4 FAILED: browser roles can load private protocol context';
  end if;
end;
$$;

rollback;
