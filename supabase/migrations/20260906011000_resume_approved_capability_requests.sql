-- Durable wake-up state for a recipient turn paused at the human file gate.
--
-- The first connector exchange resolves a filename hint to an opaque resource
-- ID and records a scope request. The waiting turn polls this projection. Once
-- the owner approves, it retries by that exact ID under the newly created
-- grant, so approval resumes the investigation instead of merely changing a
-- database row. Only the peer that made the request can resolve this batch.
create or replace function public.resolve_capability_scope_requests(
  p_task_id          uuid,
  p_peer_user_id     uuid,
  p_scope_request_ids uuid[]
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_task public.collaboration_tasks%rowtype;
begin
  if p_task_id is null
     or p_peer_user_id is null
     or p_scope_request_ids is null
     or cardinality(p_scope_request_ids) not between 1 and 16
     or cardinality(p_scope_request_ids) <> (
       select count(distinct requested_id)
       from unnest(p_scope_request_ids) as requested(requested_id)
     ) then
    return jsonb_build_object('outcome', 'task_unavailable');
  end if;

  select * into v_task
  from public.collaboration_tasks task
  where task.task_id = p_task_id;

  if not found
     or v_task.status <> 'active'
     or v_task.expires_at <= now()
     or p_peer_user_id not in (v_task.requester_user_id, v_task.responder_user_id) then
    return jsonb_build_object('outcome', 'task_unavailable');
  end if;

  return jsonb_build_object(
    'outcome', 'resolved',
    'requests', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'scopeRequestId', request.scope_request_id,
          'candidateResourceId', request.candidate_resource_id,
          'status', request.status
        ) order by request.scope_request_id
      )
      from public.capability_scope_requests request
      where request.task_id = p_task_id
        and request.peer_user_id = p_peer_user_id
        and request.scope_request_id = any(p_scope_request_ids)
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.resolve_capability_scope_requests(uuid, uuid, uuid[])
from public, anon, authenticated;

grant execute on function public.resolve_capability_scope_requests(uuid, uuid, uuid[])
to service_role;
