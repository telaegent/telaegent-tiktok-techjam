-- Makes recipient-draft creation safe to retry and ensures initial owner
-- guidance is part of the private context delivered to the recipient agent.
--
-- The key is owner-scoped and never projected to the browser after creation.
-- It is lifecycle metadata, not authority: the normal conversation/runtime
-- authorization checks still run before every creation and turn.

alter table public.private_drafts
  add column reply_idempotency_key text
    check (reply_idempotency_key is null or
           reply_idempotency_key ~ '^[A-Za-z0-9_.:-]{1,128}$');

-- Existing recipient rows predate creation idempotency. Give each a private,
-- non-reusable migration key so the new role/key shape can be enforced without
-- changing their observable draft identity or lifecycle.
update public.private_drafts
set reply_idempotency_key = 'legacy:' || draft_id::text
where role = 'recipient';

alter table public.private_drafts
  add constraint private_drafts_reply_idempotency_shape check (
    (role = 'sender' and reply_idempotency_key is null)
    or
    (role = 'recipient' and reply_idempotency_key is not null)
  );

create unique index private_drafts_owner_reply_idempotency
  on public.private_drafts (owner_user_id, reply_idempotency_key)
  where reply_idempotency_key is not null;

-- Replace the pre-idempotency signature so no backend composition can
-- accidentally keep using the unsafe creation path.
revoke all on function
  public.create_recipient_draft(uuid, uuid, bigint, uuid, text, uuid, text,
                                timestamptz, timestamptz)
from public, anon, authenticated, service_role;

drop function public.create_recipient_draft(
  uuid, uuid, bigint, uuid, text, uuid, text, timestamptz, timestamptz
);

create function public.create_recipient_draft(
  p_draft_id             uuid,
  p_conversation_id      uuid,
  p_github_repository_id bigint,
  p_owner_user_id        uuid,
  p_provider             text,
  p_incoming_message_id  uuid,
  p_owner_guidance       text,
  p_idempotency_key      text,
  p_created_at           timestamptz,
  p_updated_at           timestamptz
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_existing public.private_drafts;
  v_created  public.private_drafts;
  v_incoming_message_id uuid;
begin
  if p_idempotency_key is null or
     p_idempotency_key !~ '^[A-Za-z0-9_.:-]{1,128}$' then
    return null;
  end if;

  -- Serialize one owner's retries for one key. The unique index remains the
  -- durable invariant; this lock makes the replay result deterministic even
  -- when two HTTP requests arrive in the same millisecond.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'recipient-draft:' || p_owner_user_id::text || ':' || p_idempotency_key,
      0
    )
  );

  select draft.* into v_existing
  from public.private_drafts draft
  where draft.owner_user_id = p_owner_user_id
    and draft.reply_idempotency_key = p_idempotency_key;

  if found then
    if v_existing.role <> 'recipient' or
       v_existing.conversation_id <> p_conversation_id or
       v_existing.github_repository_id <> p_github_repository_id or
       v_existing.provider <> p_provider or
       v_existing.incoming_message_id <> p_incoming_message_id or
       v_existing.rough_message is distinct from p_owner_guidance then
      return null;
    end if;
    return jsonb_build_object(
      'draft', public.private_draft_json(v_existing),
      'replayed', true
    );
  end if;

  select message.message_id into v_incoming_message_id
  from public.shared_messages message
  join public.conversation_participants participant
    on participant.conversation_id = message.conversation_id
   and participant.user_id = p_owner_user_id
  where message.message_id = p_incoming_message_id
    and message.conversation_id = p_conversation_id
    and message.github_repository_id = p_github_repository_id
    and message.sender_user_id <> p_owner_user_id;

  if not found then
    return null;
  end if;

  insert into public.private_drafts (
    draft_id, conversation_id, github_repository_id, owner_user_id,
    provider, role, rough_message, incoming_message_id,
    reply_idempotency_key, private_turns, state, created_at, updated_at
  ) values (
    p_draft_id, p_conversation_id, p_github_repository_id, p_owner_user_id,
    p_provider, 'recipient', p_owner_guidance, v_incoming_message_id,
    p_idempotency_key,
    case when p_owner_guidance is null then '[]'::jsonb else
      jsonb_build_array(
        jsonb_build_object('speaker', 'owner', 'text', p_owner_guidance)
      )
    end,
    'created', p_created_at, p_updated_at
  )
  returning * into v_created;

  return jsonb_build_object(
    'draft', public.private_draft_json(v_created),
    'replayed', false
  );
end;
$$;

revoke all on function
  public.create_recipient_draft(uuid, uuid, bigint, uuid, text, uuid, text,
                                text, timestamptz, timestamptz)
from public, anon, authenticated;

grant execute on function
  public.create_recipient_draft(uuid, uuid, bigint, uuid, text, uuid, text,
                                text, timestamptz, timestamptz)
to service_role;
