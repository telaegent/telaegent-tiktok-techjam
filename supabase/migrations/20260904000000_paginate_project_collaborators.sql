-- Cursor pagination for project-scoped collaborator discovery.
--
-- The cursor is the peer's stable user ID. Connection-state changes therefore
-- cannot move a row between pages while the browser drains the result set.
-- Keep the existing list_project_collaborators RPC untouched so the migration
-- can be deployed before the updated server without an outage. Supabase's Data
-- API does not reliably support overloaded function names, so pagination uses
-- a distinct RPC name.

create or replace function public.list_project_collaborators_page(
  p_user_id       uuid,
  p_project_id    uuid,
  p_after_user_id uuid,
  p_limit         integer
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when p_limit is null or p_limit not between 1 and 51 or
         not exists (
           select 1
           from public.user_accounts account
           join public.project_memberships membership
             on membership.user_id = account.user_id
            and membership.status = 'active'
           join public.repository_projects project
             on project.project_id = membership.project_id
            and project.status = 'active'
           join public.github_repository_access access
             on access.user_id = account.user_id
            and access.github_repository_id = project.github_repository_id
            and access.status = 'verified'
           where account.user_id = p_user_id
             and account.status = 'active'
             and membership.project_id = p_project_id
         )
      then null
    else coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'userId', listed.user_id::text,
          'githubLogin', listed.github_login,
          'connectionStatus', listed.connection_status,
          'projectConnectionId', listed.project_connection_id
        )
        order by listed.user_id
      )
      from (
        select
          peer.user_id,
          identity.github_login,
          connection.project_connection_id::text as project_connection_id,
          case
            when connection.status is null then 'none'
            when connection.status = 'connected' then 'connected'
            when connection.status = 'revoked' then 'revoked'
            when connection.requester_user_id = p_user_id then 'pending_outgoing'
            else 'pending_incoming'
          end as connection_status
        from public.project_memberships peer
        join public.repository_projects project
          on project.project_id = peer.project_id
         and project.status = 'active'
        join public.user_accounts account
          on account.user_id = peer.user_id
         and account.status = 'active'
        join public.github_repository_access access
          on access.user_id = peer.user_id
         and access.github_repository_id = project.github_repository_id
         and access.status = 'verified'
        join public.github_connections identity
          on identity.user_id = access.user_id
         and identity.github_connection_id = access.github_connection_id
         and identity.status = 'connected'
        left join public.project_connections connection
          on connection.project_id = peer.project_id
         and least(connection.requester_user_id, connection.recipient_user_id)
             = least(p_user_id, peer.user_id)
         and greatest(connection.requester_user_id, connection.recipient_user_id)
             = greatest(p_user_id, peer.user_id)
        where peer.project_id = p_project_id
          and peer.status = 'active'
          and peer.user_id <> p_user_id
          and (p_after_user_id is null or peer.user_id > p_after_user_id)
        order by peer.user_id
        limit p_limit
      ) listed
    ), '[]'::jsonb)
  end;
$$;

revoke all on function public.list_project_collaborators_page(uuid, uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.list_project_collaborators_page(uuid, uuid, uuid, integer)
  to service_role;
