-- Owner-private draft recovery after browser navigation or reload.
--
-- The API authorizes the conversation first, and this RPC independently binds
-- the read to owner + conversation + repository. SQL never accepts a broad
-- owner-only query, and terminal sent/cancelled drafts are not recoverable.
create index if not exists private_drafts_recovery
  on public.private_drafts (
    owner_user_id,
    conversation_id,
    github_repository_id,
    updated_at desc,
    draft_id desc
  )
  where state not in ('sent', 'cancelled');

create or replace function public.list_recoverable_private_drafts(
  p_owner_user_id        uuid,
  p_conversation_id      uuid,
  p_github_repository_id bigint,
  p_limit                integer
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(payload order by updated_at desc, draft_id desc), '[]'::jsonb)
  from (
    select
      d.updated_at,
      d.draft_id,
      public.private_draft_json(d) as payload
    from public.private_drafts d
    where d.owner_user_id = p_owner_user_id
      and d.conversation_id = p_conversation_id
      and d.github_repository_id = p_github_repository_id
      and d.state not in ('sent', 'cancelled')
    order by d.updated_at desc, d.draft_id desc
    limit least(greatest(coalesce(p_limit, 0), 0), 50)
  ) as bounded;
$$;

revoke all on function public.list_recoverable_private_drafts(uuid, uuid, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.list_recoverable_private_drafts(uuid, uuid, bigint, integer)
  to service_role;
