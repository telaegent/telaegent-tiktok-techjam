-- Owner-facing inspection and individual revocation for exact file grants.
--
-- Both functions remain backend-only. They expose safe identifiers and the
-- connector-derived project-relative display label, never a canonical path or
-- file content. Repository scope and grant ownership are database predicates,
-- not frontend filters.

create or replace function public.list_owned_capability_grants(
  p_owner_user_id        uuid,
  p_github_repository_id bigint
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with grants as (
    select
      g.grant_id,
      g.task_id,
      t.conversation_id,
      t.github_repository_id,
      g.peer_user_id,
      g.resource_id,
      coalesce(label.resource_display_label, 'Known project resource')
        as resource_display_label,
      g.grant_mode,
      g.granted_at,
      g.expires_at
    from public.resource_capability_grants g
    join public.collaboration_tasks t on t.task_id = g.task_id
    left join lateral (
      select r.resource_display_label
      from public.capability_scope_requests r
      where r.grant_id = g.grant_id
        and r.owner_user_id = g.owner_user_id
        and r.task_id = g.task_id
        and r.status = 'approved'
      order by r.decided_at desc, r.scope_request_id
      limit 1
    ) label on true
    where g.owner_user_id = p_owner_user_id
      and t.github_repository_id = p_github_repository_id
      and t.status = 'active'
      and t.expires_at > now()
      and g.status = 'active'
      and g.expires_at > now()
    order by g.granted_at, g.grant_id
    limit 200
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'grantId', grants.grant_id,
        'taskId', grants.task_id,
        'conversationId', grants.conversation_id,
        'githubRepositoryId', grants.github_repository_id::text,
        'peerUserId', grants.peer_user_id,
        'resourceId', grants.resource_id,
        'resourceDisplayLabel', grants.resource_display_label,
        'operation', 'read',
        'mode', grants.grant_mode,
        'grantedAt', to_char(grants.granted_at at time zone 'utc',
                             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'expiresAt', to_char(grants.expires_at at time zone 'utc',
                             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      order by grants.granted_at, grants.grant_id
    ),
    '[]'::jsonb
  )
  from grants;
$$;

revoke all on function public.list_owned_capability_grants(uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.list_owned_capability_grants(uuid, bigint)
  to service_role;

create or replace function public.revoke_owned_capability_grant(
  p_owner_user_id uuid,
  p_grant_id      uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_grant public.resource_capability_grants;
  v_task  public.collaboration_tasks;
  v_now   timestamptz := now();
begin
  select * into v_grant
  from public.resource_capability_grants g
  where g.grant_id = p_grant_id
  for update;

  -- The same response covers a missing grant, another owner's grant, and a
  -- grant that can no longer authorize a read. This prevents identifier probes
  -- while keeping an owner's repeated DELETE of an already-revoked grant
  -- idempotently successful.
  if not found or v_grant.owner_user_id <> p_owner_user_id then
    return jsonb_build_object('outcome', 'unavailable');
  end if;

  if v_grant.status = 'revoked' then
    return jsonb_build_object('outcome', 'revoked');
  end if;

  select * into v_task
  from public.collaboration_tasks t
  where t.task_id = v_grant.task_id;

  if v_grant.status <> 'active'
     or v_grant.expires_at <= v_now
     or not found
     or v_task.status <> 'active'
     or v_task.expires_at <= v_now then
    return jsonb_build_object('outcome', 'unavailable');
  end if;

  update public.resource_capability_grants
     set status = 'revoked',
         revoked_at = greatest(v_now, granted_at)
   where grant_id = p_grant_id;

  return jsonb_build_object('outcome', 'revoked');
end;
$$;

revoke all on function public.revoke_owned_capability_grant(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_owned_capability_grant(uuid, uuid)
  to service_role;
