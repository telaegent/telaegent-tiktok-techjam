-- Corrective migration for the private-runtime authorization snapshot.
--
-- Applied on top of 20260829120000_authorization_schema.sql, which is left
-- untouched because it is already applied.
--
-- Review findings addressed, from Khoa:
--   1. projectConnections was scoped only by project and caller, so an
--      unrelated third collaborator in the same project could exhaust the
--      cardinality bound and fail a valid two-person conversation. Connections
--      are now scoped to the requested conversation's participants. Status is
--      still not filtered; pending and revoked rows reach the policy layer.
--   2. participantUserIds is bounded in SQL to p_max_project_connections + 2,
--      aggregated from a deterministically ordered subquery, so malformed data
--      cannot produce an unbounded response.
--   3. runtime_bindings now requires project membership via a composite FK.
--   4. conversation_participants carries project_id and references both the
--      conversation and the membership, so a participant cannot belong to a
--      different project than the conversation.
--
-- All three stricter constraints from the first migration are retained.

-- ---------------------------------------------------------------------------
-- 4. Conversation participants must belong to the conversation's project
-- ---------------------------------------------------------------------------
-- FK target for (conversation_id, project_id).
alter table public.project_conversations
  add constraint project_conversations_conversation_project
  unique (conversation_id, project_id);

alter table public.conversation_participants
  add column project_id uuid;

-- Backfill before the NOT NULL. The table is expected to be empty at this
-- point; the update keeps the migration correct if it is not.
update public.conversation_participants cp
set project_id = pc.project_id
from public.project_conversations pc
where pc.conversation_id = cp.conversation_id
  and cp.project_id is null;

alter table public.conversation_participants
  alter column project_id set not null;

alter table public.conversation_participants
  add constraint conversation_participants_conversation_project_fk
  foreign key (conversation_id, project_id)
  references public.project_conversations (conversation_id, project_id)
  on delete restrict;

alter table public.conversation_participants
  add constraint conversation_participants_membership_fk
  foreign key (project_id, user_id)
  references public.project_memberships (project_id, user_id)
  on delete restrict;

-- ---------------------------------------------------------------------------
-- 3. A runtime binding requires project membership
-- ---------------------------------------------------------------------------
alter table public.runtime_bindings
  add constraint runtime_bindings_membership_fk
  foreign key (project_id, user_id)
  references public.project_memberships (project_id, user_id)
  on delete restrict;

-- ---------------------------------------------------------------------------
-- 1 and 2. Snapshot RPC replacement
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE preserves the existing ownership and ACL, so the earlier
-- revoke from PUBLIC/anon/authenticated and grant to service_role still hold.
create or replace function public.load_private_runtime_authorization_snapshot(
  p_user_id                 uuid,
  p_github_repository_id    bigint,
  p_conversation_id         uuid,
  p_max_project_connections public.authz_connection_limit
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with project as (
    select rp.*
    from public.repository_projects rp
    where rp.github_repository_id = p_github_repository_id
  ),
  conversation_row as (
    -- Scoped to the requested project, so a conversation belonging to another
    -- repository yields no conversation and no participant-scoped connections.
    select pc.*
    from public.project_conversations pc
    join project p on p.project_id = pc.project_id
    where pc.conversation_id = p_conversation_id
  ),
  participants as (
    -- Bounded and deterministically ordered. One more than the connection
    -- sentinel, so the service can detect participant overflow and fail
    -- closed rather than receive an unbounded array.
    select cp.user_id
    from public.conversation_participants cp
    join conversation_row cr on cr.conversation_id = cp.conversation_id
    order by cp.user_id
    limit p_max_project_connections + 2
  )
  select jsonb_build_object(
    'user', (
      select jsonb_build_object(
        'userId', ua.user_id,
        'status', ua.status
      )
      from public.user_accounts ua
      where ua.user_id = p_user_id
    ),
    'githubConnection', (
      select jsonb_build_object(
        'githubConnectionId', gc.github_connection_id,
        'userId',             gc.user_id,
        'githubUserId',       gc.github_user_id::text,
        'githubLogin',        gc.github_login,
        'status',             gc.status,
        'connectedAt',        to_char(gc.connected_at at time zone 'utc',
                                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'lastVerifiedAt',     to_char(gc.last_verified_at at time zone 'utc',
                                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      from public.github_connections gc
      where gc.user_id = p_user_id
    ),
    'repositoryAccess', (
      select jsonb_build_object(
        'userId',             gra.user_id,
        'githubConnectionId', gra.github_connection_id,
        'githubRepositoryId', gra.github_repository_id::text,
        'status',             gra.status,
        'verifiedAt',         to_char(gra.verified_at at time zone 'utc',
                                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      from public.github_repository_access gra
      where gra.user_id = p_user_id
        and gra.github_repository_id = p_github_repository_id
    ),
    'project', (
      select jsonb_build_object(
        'projectId',          p.project_id,
        'githubRepositoryId', p.github_repository_id::text,
        'repositoryFullName', p.repository_full_name,
        'visibility',         p.visibility,
        'defaultBranch',      p.default_branch,
        'status',             p.status
      )
      from project p
    ),
    'membership', (
      select jsonb_build_object(
        'projectId', pm.project_id,
        'userId',    pm.user_id,
        'status',    pm.status,
        'joinedAt',  to_char(pm.joined_at at time zone 'utc',
                             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      from public.project_memberships pm
      join project p on p.project_id = pm.project_id
      where pm.user_id = p_user_id
    ),
    'conversation', (
      select jsonb_build_object(
        'conversationId',     cr.conversation_id,
        'projectId',          cr.project_id,
        'participantUserIds', coalesce((
          select jsonb_agg(bounded_participants.user_id
                           order by bounded_participants.user_id)
          from participants as bounded_participants
        ), '[]'::jsonb),
        'status',             cr.status
      )
      from conversation_row cr
    ),
    'projectConnections', coalesce((
      -- One more than requested, so the service can detect excessive
      -- cardinality and fail closed.
      select jsonb_agg(bounded.payload)
      from (
        select jsonb_build_object(
          'projectConnectionId', conn.project_connection_id,
          'projectId',           conn.project_id,
          'requesterUserId',     conn.requester_user_id,
          'recipientUserId',     conn.recipient_user_id,
          'status',              conn.status,
          'requestedAt',         to_char(conn.requested_at at time zone 'utc',
                                         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'acceptedAt',          to_char(conn.accepted_at at time zone 'utc',
                                         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'revokedAt',           to_char(conn.revoked_at at time zone 'utc',
                                         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) as payload
        from public.project_connections conn
        join project p on p.project_id = conn.project_id
        -- One side is the caller; the other side is a participant of the
        -- requested conversation. Status is deliberately not filtered.
        where (
          conn.requester_user_id = p_user_id
          and conn.recipient_user_id in (select user_id from participants)
        )
        or (
          conn.recipient_user_id = p_user_id
          and conn.requester_user_id in (select user_id from participants)
        )
        order by conn.requested_at, conn.project_connection_id
        limit p_max_project_connections + 1
      ) as bounded
    ), '[]'::jsonb),
    'runtimeBinding', (
      select jsonb_build_object(
        'runtimeBindingId',   rb.runtime_binding_id,
        'userId',             rb.user_id,
        'projectId',          rb.project_id,
        'githubRepositoryId', rb.github_repository_id::text,
        'status',             rb.status
      )
      from public.runtime_bindings rb
      join project p on p.project_id = rb.project_id
      where rb.user_id = p_user_id
    )
  );
$$;
