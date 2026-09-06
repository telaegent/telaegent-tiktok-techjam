-- Linearize the final human Send gate with project/membership revocation.
--
-- The service performs a fresh authorization check before this RPC, but that
-- check and message publication are two transactions. The durable writer must
-- therefore re-derive the two participants and lock every revocable row whose
-- state authorizes publication. A revocation that commits first is observed
-- and refused; a send that locks first commits before revocation. There is no
-- state in which revocation has completed and a later message can still cross.
create or replace function public.send_private_draft(
  p_draft_id             uuid,
  p_owner_user_id        uuid,
  p_approved_body        text,
  p_idempotency_key      text,
  p_message_id           uuid,
  p_conversation_id      uuid,
  p_github_repository_id bigint,
  p_provider             text,
  p_sent_at              timestamptz,
  p_approval_id          uuid,
  p_approved_at          timestamptz,
  p_updated_at           timestamptz
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_approval           public.outbound_approvals%rowtype;
  v_message            public.shared_messages%rowtype;
  v_draft              public.private_drafts%rowtype;
  v_conversation       public.project_conversations%rowtype;
  v_project            public.repository_projects%rowtype;
  v_connection         public.project_connections%rowtype;
  v_github_connection  public.github_connections%rowtype;
  v_repository_access  public.github_repository_access%rowtype;
  v_runtime_binding    public.runtime_bindings%rowtype;
  v_participants       uuid[];
  v_peer_user_id       uuid;
  v_active_memberships integer;
begin
  -- A committed send remains replayable under its original idempotency key.
  -- Revocation cannot retroactively make a message that already crossed cease
  -- to exist, and returning the same result never publishes a second message.
  select * into v_approval
  from public.outbound_approvals approval
  where approval.actor_user_id = p_owner_user_id
    and approval.idempotency_key = p_idempotency_key;

  if found then
    if v_approval.draft_id <> p_draft_id
       or v_approval.approved_body <> p_approved_body then
      return null;
    end if;
    select * into v_message
    from public.shared_messages message
    where message.message_id = v_approval.message_id;
    if not found then return null; end if;
    return jsonb_build_object(
      'message', public.shared_message_json(v_message),
      'approval', public.outbound_approval_json(v_approval),
      'replayed', true
    );
  end if;

  -- Claim the draft first. All scope values used below must agree with this
  -- owner-private record rather than merely with parameters supplied by the
  -- service process.
  select * into v_draft
  from public.private_drafts draft
  where draft.draft_id = p_draft_id
    and draft.owner_user_id = p_owner_user_id
  for update;

  if not found
     or v_draft.state <> 'ready'
     or v_draft.send_candidate is null
     or v_draft.conversation_id <> p_conversation_id
     or v_draft.github_repository_id <> p_github_repository_id
     or v_draft.provider <> p_provider then
    return null;
  end if;

  -- Repository proof registration already serializes on this stable external
  -- scope key. Joining that lock order prevents an in-flight re-proof from
  -- changing GitHub/access/binding rows while publication validates them.
  perform pg_advisory_xact_lock(
    hashtextextended('github-repository:' || v_draft.github_repository_id::text, 0)
  );

  select * into v_github_connection
  from public.github_connections github_connection
  where github_connection.user_id = p_owner_user_id
  for share;
  if not found
     or v_github_connection.status <> 'connected'
     or v_github_connection.last_verified_at is null then
    return null;
  end if;

  -- Conversation and project status are revocable authorization facts too.
  select * into v_conversation
  from public.project_conversations conversation
  where conversation.conversation_id = v_draft.conversation_id
  for update;
  if not found or v_conversation.status <> 'active' then return null; end if;

  select * into v_project
  from public.repository_projects project
  where project.project_id = v_conversation.project_id
  for share;
  if not found
     or v_project.status <> 'active'
     or v_project.github_repository_id <> v_draft.github_repository_id then
    return null;
  end if;

  -- Lock the exact participant set before deriving the peer. Two-party
  -- conversations are the product boundary; a malformed third participant
  -- must never be silently ignored.
  perform 1
  from public.conversation_participants participant
  where participant.conversation_id = v_conversation.conversation_id
  order by participant.user_id
  for share;

  select array_agg(participant.user_id order by participant.user_id)
    into v_participants
  from public.conversation_participants participant
  where participant.conversation_id = v_conversation.conversation_id;

  if coalesce(cardinality(v_participants), 0) <> 2
     or not (p_owner_user_id = any(v_participants)) then
    return null;
  end if;

  select participant.user_id into v_peer_user_id
  from public.conversation_participants participant
  where participant.conversation_id = v_conversation.conversation_id
    and participant.user_id <> p_owner_user_id;

  -- FOR SHARE conflicts with the UPDATE used by suspension/revocation. These
  -- locks are the transaction boundary the service-level precheck lacked.
  perform 1
  from public.project_memberships membership
  where membership.project_id = v_project.project_id
    and membership.user_id = any(v_participants)
  order by membership.user_id
  for share;

  select count(*) into v_active_memberships
  from public.project_memberships membership
  where membership.project_id = v_project.project_id
    and membership.user_id = any(v_participants)
    and membership.status = 'active';
  if v_active_memberships <> 2 then return null; end if;

  perform 1
  from public.user_accounts account
  where account.user_id = any(v_participants)
  order by account.user_id
  for share;
  if (
    select count(*)
    from public.user_accounts account
    where account.user_id = any(v_participants) and account.status = 'active'
  ) <> 2 then
    return null;
  end if;

  -- Lock the owner's current repository proof so disconnect or proof
  -- revocation linearizes with publication as well. A ready draft may still be
  -- sent while its connector is temporarily offline; no local execution is
  -- needed for the final human-approved publication.
  select * into v_repository_access
  from public.github_repository_access access
  where access.user_id = p_owner_user_id
    and access.github_repository_id = v_project.github_repository_id
  for share;
  if not found
     or v_repository_access.status <> 'verified'
     or v_repository_access.github_connection_id
        <> v_github_connection.github_connection_id
     or v_repository_access.verified_at < now() - interval '15 minutes'
     or v_repository_access.verified_at > now() + interval '1 minute' then
    return null;
  end if;

  select * into v_runtime_binding
  from public.runtime_bindings binding
  where binding.user_id = p_owner_user_id
    and binding.project_id = v_project.project_id
    and binding.github_repository_id = v_project.github_repository_id
  for share;
  if not found or v_runtime_binding.status <> 'ready' then return null; end if;

  select * into v_connection
  from public.project_connections connection
  where connection.project_id = v_project.project_id
    and least(connection.requester_user_id, connection.recipient_user_id)
        = least(p_owner_user_id, v_peer_user_id)
    and greatest(connection.requester_user_id, connection.recipient_user_id)
        = greatest(p_owner_user_id, v_peer_user_id)
  for share;
  if not found or v_connection.status <> 'connected' then return null; end if;

  update public.private_drafts draft
  set state = 'sent',
      send_candidate = p_approved_body,
      sent_message_id = p_message_id,
      updated_at = p_updated_at
  where draft.draft_id = v_draft.draft_id;

  insert into public.shared_messages (
    message_id, conversation_id, github_repository_id, sender_user_id,
    body, origin, provider, sent_at
  ) values (
    p_message_id, v_draft.conversation_id, v_draft.github_repository_id,
    p_owner_user_id, p_approved_body, 'agent', v_draft.provider, p_sent_at
  ) returning * into v_message;

  insert into public.outbound_approvals (
    approval_id, draft_id, message_id, actor_user_id,
    approved_body, idempotency_key, approved_at
  ) values (
    p_approval_id, v_draft.draft_id, p_message_id, p_owner_user_id,
    p_approved_body, p_idempotency_key, p_approved_at
  ) returning * into v_approval;

  return jsonb_build_object(
    'message', public.shared_message_json(v_message),
    'approval', public.outbound_approval_json(v_approval),
    'replayed', false
  );
end;
$$;

revoke all on function public.send_private_draft(
  uuid, uuid, text, text, uuid, uuid, bigint, text,
  timestamptz, uuid, timestamptz, timestamptz
) from public, anon, authenticated;

grant execute on function public.send_private_draft(
  uuid, uuid, text, text, uuid, uuid, bigint, text,
  timestamptz, uuid, timestamptz, timestamptz
) to service_role;
