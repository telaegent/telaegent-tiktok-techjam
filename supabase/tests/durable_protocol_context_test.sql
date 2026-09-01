-- Durable context for both roles must be reconstructible without provider state.
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
  v_earlier uuid := '60000000-0000-4000-8000-000000000007';
  v_reply uuid := '50000000-0000-4000-8000-000000000008';
  v_repo bigint := 9223372036854775807;
  v_context jsonb;
  v_reply_row jsonb;
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
    v_earlier, v_conversation, v_repo, v_owner,
    'The relay is on feature/relay.', 'agent', 'claude',
    statement_timestamp() - interval '5 minutes'
  ), (
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
     jsonb_array_length(v_context->'sharedHistory') <> 2 or
     v_context#>>'{sharedHistory,0,id}' <> v_earlier::text or
     v_context#>>'{sharedHistory,1,id}' <> v_message::text then
    raise exception 'T1 FAILED: durable protocol context was incomplete %', v_context;
  end if;
  if v_context::text ~* '(workspace|credential|sessionId|providerHome)' then
    raise exception 'T2 FAILED: private infrastructure leaked into context';
  end if;

  -- POST /api/drafts/:id/run atomically claims the draft before hydrating it.
  -- The durable loader must remain available in that claimed state.
  perform public.mark_private_draft_running(
    v_draft, v_owner, '70000000-0000-4000-8000-000000000007',
    statement_timestamp()
  );
  v_context := public.load_sender_protocol_context(
    v_owner, v_repo, v_conversation, v_draft, 200
  );
  if v_context is null or v_context->>'role' <> 'sender' then
    raise exception 'T2 FAILED: sender context disappeared after draft claim';
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

  -- An owner answers a collaborator, never themselves.
  if public.create_recipient_draft(
    v_reply, v_conversation, v_repo, v_peer, 'codex', v_message,
    null, 'reply-self-1', statement_timestamp(), statement_timestamp()
  ) is not null then
    raise exception 'T5 FAILED: a user opened a reply to their own message';
  end if;

  v_reply_row := (public.create_recipient_draft(
    v_reply, v_conversation, v_repo, v_owner, 'codex', v_message,
    'keep it short', 'reply-owner-1', statement_timestamp(), statement_timestamp()
  ))->'draft';
  if v_reply_row is null or
     v_reply_row->>'role' <> 'recipient' or
     v_reply_row->>'incomingMessageId' <> v_message::text or
     v_reply_row->>'roughMessage' <> 'keep it short' or
     v_reply_row#>>'{privateTurns,0,speaker}' <> 'owner' or
     v_reply_row#>>'{privateTurns,0,text}' <> 'keep it short' then
    raise exception 'T6 FAILED: recipient draft was not opened correctly %', v_reply_row;
  end if;

  if not (public.create_recipient_draft(
    '44444444-4444-4444-8444-444444444444',
    v_conversation, v_repo, v_owner, 'codex', v_message,
    'keep it short', 'reply-owner-1', statement_timestamp(), statement_timestamp()
  )->>'replayed')::boolean then
    raise exception 'T6 FAILED: recipient creation retry was not replayed';
  end if;

  if public.create_recipient_draft(
    '55555555-5555-4555-8555-555555555555',
    v_conversation, v_repo, v_owner, 'codex', v_message,
    'different guidance', 'reply-owner-1', statement_timestamp(), statement_timestamp()
  ) is not null then
    raise exception 'T6 FAILED: conflicting recipient creation replay was accepted';
  end if;

  perform public.mark_private_draft_running(
    v_reply, v_owner, '80000000-0000-4000-8000-000000000008',
    statement_timestamp()
  );

  v_context := public.load_recipient_protocol_context(
    v_owner, v_repo, v_conversation, v_reply, 200
  );
  -- The collaborator's text is delivered once, through the envelope field. If it
  -- also appeared in sharedHistory the untrusted data envelope would be
  -- decorative, so history stops strictly before the message being answered.
  if v_context->>'role' <> 'recipient' or
     v_context->>'incomingMessage' <> 'Use the approved transport contract.' or
     v_context#>>'{facts,collaboratorName}' <> 'justin' or
     jsonb_array_length(v_context->'sharedHistory') <> 1 or
     v_context#>>'{sharedHistory,0,id}' <> v_earlier::text then
    raise exception 'T7 FAILED: claimed recipient context was wrong %', v_context;
  end if;

  -- load_sender_protocol_context hardcodes 'role', 'sender' in its own result,
  -- so a recipient row loaded through it would arrive claiming to be a sender
  -- turn and no caller could tell. Each loader rejects the other role itself.
  if public.load_sender_protocol_context(
    v_owner, v_repo, v_conversation, v_reply, 200
  ) is not null then
    raise exception 'T8 FAILED: the sender loader returned a recipient draft';
  end if;
  if public.load_recipient_protocol_context(
    v_owner, v_repo, v_conversation, v_draft, 200
  ) is not null then
    raise exception 'T9 FAILED: the recipient loader returned a sender draft';
  end if;
  if public.load_recipient_protocol_context(
    v_peer, v_repo, v_conversation, v_reply, 200
  ) is not null then
    raise exception 'T10 FAILED: another user loaded the owner private reply';
  end if;

  if has_function_privilege(
    'anon', 'public.load_recipient_protocol_context(uuid,bigint,uuid,uuid,integer)', 'EXECUTE'
  ) or has_function_privilege(
    'authenticated', 'public.load_recipient_protocol_context(uuid,bigint,uuid,uuid,integer)', 'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.create_recipient_draft(uuid,uuid,bigint,uuid,text,uuid,text,text,timestamptz,timestamptz)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.create_recipient_draft(uuid,uuid,bigint,uuid,text,uuid,text,text,timestamptz,timestamptz)',
    'EXECUTE'
  ) then
    raise exception 'T11 FAILED: browser roles can reach the recipient half';
  end if;
end;
$$;

rollback;
