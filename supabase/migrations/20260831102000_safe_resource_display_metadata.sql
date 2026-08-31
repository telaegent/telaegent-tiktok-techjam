-- Safe, owner-connector-derived display metadata for capability approvals.
--
-- A known resource is represented in the cloud by an opaque resource ID. The
-- owner still needs an intelligible name before granting access, so the local
-- connector also sends a normalized project-relative label. This column can
-- never contain the canonical local path.

alter table public.capability_scope_requests
  add column resource_display_label text;

-- Old pending rows predate the connector-derived contract. Do not promote the
-- peer's requested hint into verified metadata; use an honest neutral label.
update public.capability_scope_requests
set resource_display_label = 'Known project resource'
where resource_display_label is null;

create function public.record_capability_scope_request(
  p_scope_request_id       uuid,
  p_task_id                uuid,
  p_owner_user_id          uuid,
  p_peer_user_id           uuid,
  p_requested_hint         text,
  p_requested_reason       text,
  p_candidate_resource_id  text,
  p_resource_display_label text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_task     public.collaboration_tasks;
  v_existing public.capability_scope_requests;
  v_grant    public.resource_capability_grants;
  v_now      timestamptz := now();
begin
  if p_candidate_resource_id !~ '^resource_[A-Za-z0-9_-]{16,120}$'
     or p_requested_reason is null
     or length(p_requested_reason) not between 1 and 2000
     or (p_requested_hint is not null
         and (length(p_requested_hint) not between 1 and 512
              or p_requested_hint ~ '[[:cntrl:]]'))
     or p_resource_display_label is null
     or length(p_resource_display_label) not between 1 and 512
     or p_resource_display_label ~ '[[:cntrl:]]'
     or p_resource_display_label ~ '^/'
     or p_resource_display_label ~ '^[A-Za-z]:'
     or position(E'\\' in p_resource_display_label) <> 0
     or p_resource_display_label ~ '(^/|/$|//|(^|/)\.{1,2}(/|$))' then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  select * into v_task
  from public.collaboration_tasks t
  where t.task_id = p_task_id
  for update;

  if not found or v_task.status <> 'active' or v_task.expires_at <= v_now then
    return jsonb_build_object('outcome', 'task_unavailable');
  end if;

  if not (
    (v_task.requester_user_id = p_peer_user_id
      and v_task.responder_user_id = p_owner_user_id)
    or
    (v_task.responder_user_id = p_peer_user_id
      and v_task.requester_user_id = p_owner_user_id)
  ) then
    return jsonb_build_object('outcome', 'task_unavailable');
  end if;

  select * into v_grant
  from public.resource_capability_grants g
  where g.task_id = p_task_id
    and g.owner_user_id = p_owner_user_id
    and g.peer_user_id = p_peer_user_id
    and g.resource_id = p_candidate_resource_id
    and g.operation = 'read'
    and g.status = 'active'
    and g.expires_at > v_now;

  if found then
    return jsonb_build_object(
      'outcome', 'already_granted', 'grantId', v_grant.grant_id
    );
  end if;

  select * into v_existing
  from public.capability_scope_requests r
  where r.task_id = p_task_id
    and r.candidate_resource_id = p_candidate_resource_id
    and r.status = 'pending'
  for update;

  if found then
    return jsonb_build_object(
      'outcome', 'existing', 'scopeRequestId', v_existing.scope_request_id
    );
  end if;

  insert into public.capability_scope_requests (
    scope_request_id, task_id, owner_user_id, peer_user_id, requested_hint,
    requested_reason, candidate_resource_id, resource_display_label, status,
    decision, grant_id, requested_at, decided_at
  ) values (
    p_scope_request_id, p_task_id, p_owner_user_id, p_peer_user_id,
    p_requested_hint, p_requested_reason, p_candidate_resource_id,
    p_resource_display_label, 'pending', null, null, v_now, null
  );
  return jsonb_build_object('outcome', 'recorded', 'scopeRequestId', p_scope_request_id);
end;
$$;

-- Rolling-deploy compatibility. An old backend may briefly call the seven
-- argument RPC after this migration lands. Keep it service-role-only and give
-- it a truthful neutral label rather than treating the peer's hint as verified
-- connector metadata. A later cleanup migration may remove this overload once
-- every control-plane instance runs the new contract.
create or replace function public.record_capability_scope_request(
  p_scope_request_id      uuid,
  p_task_id               uuid,
  p_owner_user_id         uuid,
  p_peer_user_id          uuid,
  p_requested_hint        text,
  p_requested_reason      text,
  p_candidate_resource_id text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select public.record_capability_scope_request(
    p_scope_request_id,
    p_task_id,
    p_owner_user_id,
    p_peer_user_id,
    p_requested_hint,
    p_requested_reason,
    p_candidate_resource_id,
    'Known project resource'
  );
$$;

revoke all on function public.record_capability_scope_request(
  uuid, uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;

grant execute on function public.record_capability_scope_request(
  uuid, uuid, uuid, uuid, text, text, text
) to service_role;

alter table public.capability_scope_requests
  alter column resource_display_label set not null,
  add constraint capability_scope_requests_safe_display_label check (
    length(resource_display_label) between 1 and 512
    and resource_display_label !~ '[[:cntrl:]]'
    and resource_display_label !~ '^/'
    and resource_display_label !~ '^[A-Za-z]:'
    and position(E'\\' in resource_display_label) = 0
    and resource_display_label !~ '(^/|/$|//|(^|/)\.{1,2}(/|$))'
  );

revoke all on function public.record_capability_scope_request(
  uuid, uuid, uuid, uuid, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.record_capability_scope_request(
  uuid, uuid, uuid, uuid, text, text, text, text
) to service_role;

create or replace function public.list_pending_capability_scope_requests(
  p_owner_user_id        uuid,
  p_github_repository_id bigint
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'scopeRequestId', r.scope_request_id,
        'taskId', r.task_id,
        'conversationId', t.conversation_id,
        'githubRepositoryId', t.github_repository_id::text,
        'peerUserId', r.peer_user_id,
        'requestedHint', r.requested_hint,
        'requestedReason', r.requested_reason,
        'candidateResourceId', r.candidate_resource_id,
        'resourceDisplayLabel', r.resource_display_label,
        'operation', 'read',
        'requestedAt', to_char(r.requested_at at time zone 'utc',
                               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'taskExpiresAt', to_char(t.expires_at at time zone 'utc',
                                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      order by r.requested_at, r.scope_request_id
    ),
    '[]'::jsonb
  )
  from public.capability_scope_requests r
  join public.collaboration_tasks t on t.task_id = r.task_id
  where r.owner_user_id = p_owner_user_id
    and r.status = 'pending'
    and t.github_repository_id = p_github_repository_id
    and t.status = 'active'
    and t.expires_at > now();
$$;

revoke all on function public.list_pending_capability_scope_requests(uuid, bigint)
  from public, anon, authenticated;

grant execute on function public.list_pending_capability_scope_requests(uuid, bigint)
  to service_role;
