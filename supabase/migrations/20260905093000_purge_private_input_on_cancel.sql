-- Rejecting a draft has to erase what the owner typed into it.
--
-- A private draft holds the rawest input in the product: the owner's rough
-- message, their steering guidance, and the clarification transcript between
-- them and the agent. None of it is redacted on the way in, deliberately -- it
-- is private-side content that has not crossed any boundary, and redacting an
-- owner's own notes back at them would be wrong.
--
-- Cancelling was clearing only `send_candidate`. Everything else survived, so a
-- draft an owner rejected precisely *because* they had pasted a credential into
-- it kept that credential in the row indefinitely. "No" has to mean the content
-- is gone, not merely that it will not be sent.
--
-- Scope: this is the rejection path only. A retention policy for drafts that
-- were sent or that simply age out is a separate piece of work and is not
-- claimed here.

-- A purged sender draft has no rough message left, which the shape constraint
-- did not allow. Cancelled is the only state where that is true.
alter table public.private_drafts
  drop constraint private_drafts_role_shape;

alter table public.private_drafts
  add constraint private_drafts_role_shape check (
    (role = 'sender'
       and incoming_message_id is null
       and (rough_message is not null or state = 'cancelled'))
    or
    (role = 'recipient'
       and incoming_message_id is not null)
  );

-- Cancellation is idempotent for already-terminal drafts and, for a running
-- draft, requires the caller to name the turn it believes is running. Both
-- behaviours are unchanged; only the columns cleared on the way out differ.
create or replace function public.cancel_private_draft(
  p_draft_id         uuid,
  p_owner_user_id    uuid,
  p_expected_turn_id uuid,
  p_updated_at       timestamptz
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_state  text;
  v_result jsonb;
begin
  select d.state into v_state
  from public.private_drafts d
  where d.draft_id = p_draft_id
    and d.owner_user_id = p_owner_user_id;

  if not found then
    return null;
  end if;

  if v_state in ('sent', 'cancelled') then
    return public.get_private_draft(p_draft_id);
  end if;

  if v_state = 'agent_working'
     and (p_expected_turn_id is null
          or not exists (
            select 1 from public.private_drafts d
            where d.draft_id = p_draft_id and d.turn_id = p_expected_turn_id)) then
    return null;
  end if;

  update public.private_drafts as d
  set state = 'cancelled',
      -- Everything the owner typed, and everything the agent wrote back to
      -- them privately. A rejected draft keeps its identity and its audit
      -- timestamps; it does not keep its content.
      rough_message = null,
      private_turns = '[]'::jsonb,
      private_message = null,
      send_candidate = null,
      risk_flags = '[]'::jsonb,
      guard_findings = '[]'::jsonb,
      updated_at = p_updated_at
  where d.draft_id = p_draft_id
    and d.owner_user_id = p_owner_user_id
  returning public.private_draft_json(d) into v_result;

  return v_result;
end;
$$;
