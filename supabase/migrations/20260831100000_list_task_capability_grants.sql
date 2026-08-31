-- Reading back the authority a human already delegated inside one task.
--
-- A grant approved for a task outlives the round it was approved in. When the
-- asking agent comes back - a later turn, after the owner pressed
-- "Allow for this task" - the cloud has to know which resources it may assert
-- authority over, or every follow-up would ask the same human the same question
-- again.
--
-- This reads; it never widens. It returns only grants that are still active,
-- still unexpired, and belong to exactly this task and this pair of people, and
-- it returns identifiers rather than anything about the files themselves. The
-- resource identifier is opaque here as everywhere: only the owner's connector
-- can turn it back into a path.
create or replace function public.list_task_capability_grants(
  p_task_id       uuid,
  p_owner_user_id uuid,
  p_peer_user_id  uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_task  public.collaboration_tasks;
  v_now   timestamptz := now();
  v_items jsonb;
begin
  -- Nobody may hold a grant against themselves, and asking as if they could is
  -- refused before any row is read.
  if p_owner_user_id = p_peer_user_id then
    return jsonb_build_object('outcome', 'unavailable');
  end if;

  select * into v_task
  from public.collaboration_tasks t
  where t.task_id = p_task_id;

  -- One answer for a task that never existed, one belonging to other people,
  -- and one already closed or lapsed. A caller cannot learn which by the shape
  -- of the reply.
  --
  -- Either peer may be the owner: whichever direction a question travels, the
  -- pair has to be exactly the task's two people.
  if not found
     or v_task.status <> 'active'
     or v_task.expires_at <= v_now
     or not (
       (v_task.requester_user_id = p_peer_user_id
         and v_task.responder_user_id = p_owner_user_id)
       or
       (v_task.responder_user_id = p_peer_user_id
         and v_task.requester_user_id = p_owner_user_id)
     ) then
    return jsonb_build_object('outcome', 'unavailable');
  end if;

  -- Bounded on purpose. A ledger is carried into a prompt-sized round, so it
  -- has to stay small enough that no caller has to page it.
  select coalesce(
           jsonb_agg(
             jsonb_build_object('grantId', g.grant_id, 'resourceId', g.resource_id)
             order by g.granted_at, g.grant_id
           ),
           '[]'::jsonb
         )
    into v_items
  from (
    select g.grant_id, g.resource_id, g.granted_at
    from public.resource_capability_grants g
    where g.task_id = p_task_id
      and g.owner_user_id = p_owner_user_id
      and g.peer_user_id = p_peer_user_id
      and g.status = 'active'
      and g.expires_at > v_now
    order by g.granted_at, g.grant_id
    limit 64
  ) g;

  return jsonb_build_object('outcome', 'listed', 'grants', v_items);
end;
$$;

revoke all on function public.list_task_capability_grants(
  uuid, uuid, uuid
) from public, anon, authenticated;

grant execute on function public.list_task_capability_grants(
  uuid, uuid, uuid
) to service_role;
