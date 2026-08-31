-- Browser-authenticated, project-scoped repository disconnect.
--
-- The backend supplies p_user_id from the opaque Telaegent web session. The
-- browser supplies only the project ID. This function derives the repository
-- and binding, stops that exact user x project runtime, and retires active
-- task authority in one transaction. It does not revoke the user's GitHub
-- identity or connector credential, which may serve unrelated repositories.

create or replace function public.disconnect_user_repository(
  p_user_id uuid,
  p_project_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_now        timestamptz := statement_timestamp();
  v_project    public.repository_projects%rowtype;
  v_membership public.project_memberships%rowtype;
  v_access     public.github_repository_access%rowtype;
  v_binding    public.runtime_bindings%rowtype;
  v_changed    boolean;
begin
  if p_user_id is null or p_project_id is null then
    return null;
  end if;

  -- Serialize disconnect/re-proof operations for only this user and project.
  perform pg_advisory_xact_lock(
    hashtextextended('repository-disconnect:' || p_user_id::text || ':' || p_project_id::text, 0)
  );

  if not exists (
    select 1 from public.user_accounts account
    where account.user_id = p_user_id and account.status = 'active'
  ) then
    return null;
  end if;

  select project.* into v_project
  from public.repository_projects project
  where project.project_id = p_project_id
    and project.status = 'active'
  for update;
  if not found then return null; end if;

  select membership.* into v_membership
  from public.project_memberships membership
  where membership.project_id = p_project_id
    and membership.user_id = p_user_id
  for update;
  if not found or v_membership.status = 'revoked' then return null; end if;

  select access.* into v_access
  from public.github_repository_access access
  where access.user_id = p_user_id
    and access.github_repository_id = v_project.github_repository_id
  for update;
  if not found or v_access.status = 'revoked' then return null; end if;

  select binding.* into v_binding
  from public.runtime_bindings binding
  where binding.project_id = p_project_id
    and binding.user_id = p_user_id
    and binding.github_repository_id = v_project.github_repository_id
  for update;
  if not found or v_binding.status = 'revoked' then return null; end if;

  v_changed :=
    v_membership.status <> 'suspended'
    or v_access.status <> 'revalidation_required'
    or v_binding.status <> 'stopped'
    or v_binding.connector_instance_id is not null
    or v_binding.current_branch is not null
    or v_binding.commit_sha is not null
    or v_binding.repository_permission is not null;

  -- Cancel active collaboration before removing runtime authority. Active
  -- grants are explicitly revoked so reconnecting cannot revive old scope.
  update public.resource_capability_grants grant_row
  set status = 'revoked',
      revoked_at = greatest(v_now, grant_row.granted_at)
  where grant_row.status = 'active'
    and exists (
      select 1
      from public.collaboration_tasks task
      where task.task_id = grant_row.task_id
        and task.project_id = p_project_id
        and task.status = 'active'
        and (task.requester_user_id = p_user_id or task.responder_user_id = p_user_id)
    );

  update public.collaboration_tasks task
  set status = 'cancelled',
      ended_at = greatest(v_now, task.created_at)
  where task.project_id = p_project_id
    and task.status = 'active'
    and (task.requester_user_id = p_user_id or task.responder_user_id = p_user_id);

  update public.github_repository_access
  set status = 'revalidation_required', revoked_at = null
  where user_id = p_user_id
    and github_repository_id = v_project.github_repository_id;

  update public.project_memberships
  set status = 'suspended', revoked_at = null
  where project_id = p_project_id and user_id = p_user_id;

  update public.runtime_bindings
  set status = 'stopped',
      connector_instance_id = null,
      current_branch = null,
      commit_sha = null,
      repository_permission = null,
      unavailable_reason = null,
      unavailable_at = null
  where runtime_binding_id = v_binding.runtime_binding_id;

  return jsonb_build_object(
    'projectId', p_project_id,
    'githubRepositoryId', v_project.github_repository_id::text,
    'repositoryAccessStatus', 'revalidation_required',
    'membershipStatus', 'suspended',
    'bindingStatus', 'stopped',
    'disconnectedAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'changed', v_changed
  );
end;
$$;

revoke all on function public.disconnect_user_repository(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.disconnect_user_repository(uuid, uuid)
  to service_role;
