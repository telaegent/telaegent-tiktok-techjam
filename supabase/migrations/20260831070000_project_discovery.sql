-- Owner-scoped project/repository discovery for the Telaegent browser.
--
-- A project is discoverable only through the caller's own durable membership,
-- independently verified repository access, and opaque runtime binding. The
-- response contains safe cloud metadata only; no path, credential, remote URL,
-- repository content, provider session, or private draft can enter this RPC.

-- Membership's primary key is project-first. Discovery is user-first, so give
-- the planner a matching access path before exposing the list endpoint.
create index project_memberships_by_user_project
  on public.project_memberships (user_id, project_id);

create or replace function public.list_user_projects(
  p_user_id uuid,
  p_after_github_repository_id bigint,
  p_limit integer
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when p_limit is null or p_limit not between 1 and 51 or
         (p_after_github_repository_id is not null and
          p_after_github_repository_id <= 0) or
         not exists (
           select 1
           from public.user_accounts account
           where account.user_id = p_user_id
             and account.status = 'active'
         )
      then null
    else coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'projectId', listed.project_id::text,
          'githubRepositoryId', listed.github_repository_id::text,
          'repositoryFullName', listed.repository_full_name,
          'visibility', listed.visibility,
          'defaultBranch', listed.default_branch,
          'projectStatus', listed.project_status,
          'membershipStatus', listed.membership_status,
          'membershipJoinedAt', to_char(
            listed.membership_joined_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ),
          'githubConnectionStatus', listed.github_connection_status,
          'repositoryAccessStatus', listed.repository_access_status,
          'repositoryVerifiedAt', to_char(
            listed.repository_verified_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ),
          'connectedCollaboratorCount', listed.connected_collaborator_count,
          'binding', jsonb_build_object(
            'connectorBindingId', listed.runtime_binding_id::text,
            'connectorInstanceId', listed.connector_instance_id,
            'status', listed.binding_status,
            'currentBranch', listed.current_branch,
            'commitSha', listed.commit_sha,
            'repositoryPermission', listed.repository_permission,
            'lastVerifiedAt', case
              when listed.binding_last_verified_at is null then null
              else to_char(
                listed.binding_last_verified_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              )
            end,
            'lastSeenAt', case
              when listed.binding_last_seen_at is null then null
              else to_char(
                listed.binding_last_seen_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              )
            end,
            'unavailableReason', listed.unavailable_reason
          )
        )
        order by listed.github_repository_id
      )
      from (
        select
          project.project_id,
          project.github_repository_id,
          project.repository_full_name,
          project.visibility,
          project.default_branch,
          project.status as project_status,
          membership.status as membership_status,
          membership.joined_at as membership_joined_at,
          connection.status as github_connection_status,
          access.status as repository_access_status,
          access.verified_at as repository_verified_at,
          binding.runtime_binding_id,
          binding.connector_instance_id,
          binding.status as binding_status,
          binding.current_branch,
          binding.commit_sha,
          binding.repository_permission,
          binding.last_verified_at as binding_last_verified_at,
          binding.last_seen_at as binding_last_seen_at,
          binding.unavailable_reason,
          (
            select count(*)::integer
            from public.project_connections collaborator
            where collaborator.project_id = project.project_id
              and collaborator.status = 'connected'
              and (
                collaborator.requester_user_id = p_user_id or
                collaborator.recipient_user_id = p_user_id
              )
          ) as connected_collaborator_count
        from public.project_memberships membership
        join public.repository_projects project
          on project.project_id = membership.project_id
        join public.github_repository_access access
          on access.user_id = membership.user_id
         and access.github_repository_id = project.github_repository_id
        join public.github_connections connection
          on connection.user_id = access.user_id
         and connection.github_connection_id = access.github_connection_id
        join public.runtime_bindings binding
          on binding.user_id = membership.user_id
         and binding.project_id = project.project_id
         and binding.github_repository_id = project.github_repository_id
        where membership.user_id = p_user_id
          and (
            p_after_github_repository_id is null or
            project.github_repository_id > p_after_github_repository_id
          )
        order by project.github_repository_id
        limit p_limit
      ) listed
    ), '[]'::jsonb)
  end;
$$;

revoke all on function public.list_user_projects(uuid, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.list_user_projects(uuid, bigint, integer)
  to service_role;
