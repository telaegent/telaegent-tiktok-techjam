-- Reading a transcript that outgrew one page.
--
-- `list_shared_messages` takes only a limit, and the adapter asks for one more
-- row than its ceiling so it can tell a complete transcript from a truncated
-- one. Past that ceiling it raises CONVERSATION_TRANSCRIPT_TOO_LARGE, and
-- because there was no other way to read messages, an established conversation
-- simply stopped loading -- permanently, with no way forward for its owners.
--
-- Keyset pagination on the same `(sent_at, message_id)` order the unpaginated
-- function already used. Keyset rather than OFFSET because a transcript grows
-- while it is being read, and OFFSET would skip or repeat messages as it does.
-- The tuple comparison uses the index directly and stays correct when many
-- messages share a timestamp, which is exactly when ordering by `sent_at`
-- alone would be ambiguous.
create or replace function public.list_shared_messages_page(
  p_conversation_id uuid,
  p_after_sent_at   timestamptz,
  p_after_message_id uuid,
  p_limit           integer
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(payload order by sent_at, message_id), '[]'::jsonb)
  from (
    select m.sent_at, m.message_id, public.shared_message_json(m) as payload
    from public.shared_messages m
    where m.conversation_id = p_conversation_id
      -- Null cursor means the first page. Both cursor halves are supplied
      -- together or not at all; a row equal to the cursor is excluded.
      and (
        p_after_sent_at is null
        or p_after_message_id is null
        or (m.sent_at, m.message_id) > (p_after_sent_at, p_after_message_id)
      )
    order by m.sent_at, m.message_id
    limit p_limit
  ) as bounded;
$$;

-- Serves the keyset predicate and the ordering from one index.
create index if not exists shared_messages_by_conversation_order
  on public.shared_messages (conversation_id, sent_at, message_id);

revoke all on function
  public.list_shared_messages_page(uuid, timestamptz, uuid, integer)
from public, anon, authenticated;

grant execute on function
  public.list_shared_messages_page(uuid, timestamptz, uuid, integer)
to service_role;
