-- Treat a partial keyset cursor as invalid/no rows instead of silently
-- restarting at page one. Application callers always supply both cursor
-- components together, but keeping that invariant in SQL prevents a malformed
-- internal call from duplicating a transcript page.
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
      and (
        (p_after_sent_at is null and p_after_message_id is null)
        or (
          p_after_sent_at is not null
          and p_after_message_id is not null
          and (m.sent_at, m.message_id) > (p_after_sent_at, p_after_message_id)
        )
      )
    order by m.sent_at, m.message_id
    limit p_limit
  ) as bounded;
$$;

revoke all on function public.list_shared_messages_page(uuid, timestamptz, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.list_shared_messages_page(uuid, timestamptz, uuid, integer)
  to service_role;
