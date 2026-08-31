-- Owner-scoped, browser-safe connector onboarding status.
--
-- The control plane supplies p_user_id from the authenticated Telaegent
-- session. The response deliberately excludes bearer/token hashes, local
-- paths, remote URLs, GitHub/provider credentials, and provider sessions.

create or replace function public.load_connector_setup_status(
  p_user_id uuid,
  p_connector_instance_id text,
  p_max_bindings integer default 25
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with active_account as (
    select account.user_id
    from public.user_accounts account
    where account.user_id = p_user_id
      and account.status = 'active'
      and p_connector_instance_id ~ '^[A-Za-z0-9_-]{16,128}$'
      and p_max_bindings between 1 and 25
  ),
  latest_credential as (
    select
      credential.credential_id,
      case
        when credential.revoked_at is not null then 'revoked'
        when credential.expires_at <= statement_timestamp() then 'expired'
        else 'active'
      end as status,
      credential.expires_at,
      credential.last_seen_at
    from public.connector_credentials credential
    join active_account account on account.user_id = credential.user_id
    where credential.connector_instance_id = p_connector_instance_id
    order by credential.created_at desc, credential.credential_id desc
    limit 1
  ),
  candidate_bindings as (
    select
      binding.runtime_binding_id,
      binding.project_id,
      binding.github_repository_id,
      project.repository_full_name,
      project.visibility,
      project.default_branch,
      binding.current_branch,
      binding.commit_sha,
      binding.repository_permission,
      access.status as repository_access_status,
      membership.status as membership_status,
      binding.status as binding_status,
      binding.last_verified_at,
      binding.last_seen_at,
      binding.unavailable_reason
    from public.runtime_bindings binding
    join active_account account on account.user_id = binding.user_id
    join public.repository_projects project
      on project.project_id = binding.project_id
     and project.github_repository_id = binding.github_repository_id
    join public.github_repository_access access
      on access.user_id = binding.user_id
     and access.github_repository_id = binding.github_repository_id
    join public.project_memberships membership
      on membership.project_id = binding.project_id
     and membership.user_id = binding.user_id
    where binding.connector_instance_id = p_connector_instance_id
    order by project.repository_full_name, binding.runtime_binding_id
    limit p_max_bindings + 1
  ),
  bounded_bindings as (
    select candidate.*
    from candidate_bindings candidate
    order by candidate.repository_full_name, candidate.runtime_binding_id
    limit p_max_bindings
  )
  select case
    when not exists (select 1 from active_account) then null
    else jsonb_build_object(
      'connectorInstanceId', p_connector_instance_id,
      'credential', (
        select jsonb_build_object(
          'status', credential.status,
          'expiresAt', to_char(
            credential.expires_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ),
          'lastSeenAt', case
            when credential.last_seen_at is null then null
            else to_char(
              credential.last_seen_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            )
          end
        )
        from latest_credential credential
      ),
      'bindings', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'connectorBindingId', binding.runtime_binding_id::text,
            'projectId', binding.project_id::text,
            'githubRepositoryId', binding.github_repository_id::text,
            'repositoryFullName', binding.repository_full_name,
            'visibility', binding.visibility,
            'defaultBranch', binding.default_branch,
            'currentBranch', binding.current_branch,
            'commitSha', binding.commit_sha,
            'repositoryPermission', binding.repository_permission,
            'repositoryAccessStatus', binding.repository_access_status,
            'membershipStatus', binding.membership_status,
            'bindingStatus', binding.binding_status,
            'verifiedAt', case
              when binding.last_verified_at is null then null
              else to_char(
                binding.last_verified_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              )
            end,
            'bindingLastSeenAt', case
              when binding.last_seen_at is null then null
              else to_char(
                binding.last_seen_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              )
            end,
            'unavailableReason', binding.unavailable_reason
          )
          order by binding.repository_full_name, binding.runtime_binding_id
        )
        from bounded_bindings binding
      ), '[]'::jsonb),
      'bindingsTruncated', (
        select count(*) > p_max_bindings from candidate_bindings
      )
    )
  end;
$$;

revoke all on function public.load_connector_setup_status(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.load_connector_setup_status(uuid, text, integer)
  to service_role;
