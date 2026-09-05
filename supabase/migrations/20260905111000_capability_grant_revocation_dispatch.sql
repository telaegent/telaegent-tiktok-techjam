-- Return the safe local-dispatch metadata needed to mirror an owner
-- revocation into the connector reference monitor. The browser still receives
-- only { outcome: 'revoked' }; resource IDs and expiry stay server-side.

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

  if not found or v_grant.owner_user_id <> p_owner_user_id then
    return jsonb_build_object('outcome', 'unavailable');
  end if;

  if v_grant.status = 'revoked' then
    return jsonb_build_object(
      'outcome', 'revoked',
      'grantId', v_grant.grant_id,
      'resourceId', v_grant.resource_id,
      'expiresAt', to_char(v_grant.expires_at at time zone 'utc',
                           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
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

  return jsonb_build_object(
    'outcome', 'revoked',
    'grantId', v_grant.grant_id,
    'resourceId', v_grant.resource_id,
    'expiresAt', to_char(v_grant.expires_at at time zone 'utc',
                         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$$;

revoke all on function public.revoke_owned_capability_grant(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_owned_capability_grant(uuid, uuid)
  to service_role;
