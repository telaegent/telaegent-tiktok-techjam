-- Make rejection and publication mutually exclusive, and finish purging the
-- private execution record on rejection.
--
-- The earlier cancellation function read the state and updated it in separate
-- statements without locking the row. A concurrent Send could commit between
-- those statements, after which Cancel could overwrite `sent` with
-- `cancelled`. Locking the draft first linearizes the two human choices: the
-- transaction that owns the row wins, and a committed Send is never erased.
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
  v_draft  public.private_drafts%rowtype;
  v_result jsonb;
begin
  select * into v_draft
  from public.private_drafts draft
  where draft.draft_id = p_draft_id
    and draft.owner_user_id = p_owner_user_id
  for update;

  if not found then return null; end if;

  -- Idempotent terminal handling happens after the lock. If Send committed
  -- first, its shared message and approval remain authoritative.
  if v_draft.state in ('sent', 'cancelled') then
    return public.get_private_draft(p_draft_id);
  end if;

  if v_draft.state = 'agent_working'
     and (p_expected_turn_id is null
          or v_draft.turn_id is distinct from p_expected_turn_id) then
    return null;
  end if;

  update public.private_drafts draft
  set state = 'cancelled',
      rough_message = null,
      private_turns = '[]'::jsonb,
      turn_id = null,
      private_message = null,
      send_candidate = null,
      risk_flags = '[]'::jsonb,
      guard_findings = '[]'::jsonb,
      failure = null,
      updated_at = p_updated_at
  where draft.draft_id = v_draft.draft_id
  returning public.private_draft_json(draft) into v_result;

  return v_result;
end;
$$;

revoke all on function public.cancel_private_draft(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.cancel_private_draft(uuid, uuid, uuid, timestamptz)
  to service_role;
