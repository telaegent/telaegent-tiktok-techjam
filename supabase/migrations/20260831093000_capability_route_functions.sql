-- Routing functions for the capability loop.
--
-- 20260831092000 created the task and grant tables but no callable surface, so
-- CapabilityRouteAuthorizationService had nothing to read from. These three
-- functions are that surface.
--
-- None of them authorizes a file read. They answer only cloud-safe routing
-- questions: does this exact grant exist, may it still be reused, and which
-- connector owns it. The owner's local connector remains the reference monitor
-- and re-checks its own registry, containment, secret deny list and byte
-- budgets immediately before opening anything. No path, file content, glob,
-- directory or credential can be expressed here.

-- ---------------------------------------------------------------------------
-- 1. Snapshot read
-- ---------------------------------------------------------------------------
-- Returns facts, never a decision. Inactive, expired, revoked and mismatched
-- rows are all returned as they are, so the service can distinguish
-- "unavailable" from "inconsistent scope" and fail closed on either.
create or replace function public.load_capability_route_authorization_snapshot(
  p_peer_user_id         uuid,
  p_owner_user_id        uuid,
  p_github_repository_id bigint,
  p_conversation_id      uuid,
  p_task_id              uuid,
  p_grant_id             uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with task as (
    -- Scoped by repository and conversation, so a task belonging to another
    -- repository yields no task and therefore no project, grant or binding.
    -- Repository ID is the scope boundary: repo A never authorizes repo B.
    select ct.*
    from public.collaboration_tasks ct
    where ct.task_id = p_task_id
      and ct.github_repository_id = p_github_repository_id
      and ct.conversation_id = p_conversation_id
  ),
  project as (
    select rp.*
    from public.repository_projects rp
    join task t on t.project_id = rp.project_id
    where rp.github_repository_id = p_github_repository_id
  ),
  conversation_row as (
    select pc.*
    from public.project_conversations pc
    join project p on p.project_id = pc.project_id
    where pc.conversation_id = p_conversation_id
  ),
  participants as (
    -- One more than a two-peer conversation, so the service observes overflow
    -- and refuses rather than silently authorizing a wider room.
    select cp.user_id
    from public.conversation_participants cp
    join conversation_row cr on cr.conversation_id = cp.conversation_id
    order by cp.user_id
    limit 3
  )
  select jsonb_build_object(
    'task', (
      select jsonb_build_object(
        'taskId',                 t.task_id,
        'projectId',              t.project_id,
        'conversationId',         t.conversation_id,
        'githubRepositoryId',     t.github_repository_id::text,
        'requesterUserId',        t.requester_user_id,
        'responderUserId',        t.responder_user_id,
        'originSharedMessageId',  t.origin_shared_message_id,
        'status',                 t.status,
        'createdAt',              to_char(t.created_at at time zone 'utc',
                                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'expiresAt',              to_char(t.expires_at at time zone 'utc',
                                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'endedAt',                to_char(t.ended_at at time zone 'utc',
                                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      from task t
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
    'conversation', (
      select jsonb_build_object(
        'conversationId',     cr.conversation_id,
        'projectId',          cr.project_id,
        'participantUserIds', coalesce((
          select jsonb_agg(bounded.user_id order by bounded.user_id)
          from participants as bounded
        ), '[]'::jsonb),
        'status',             cr.status
      )
      from conversation_row cr
    ),
    'requesterMembership', (
      select jsonb_build_object(
        'projectId', pm.project_id,
        'userId',    pm.user_id,
        'status',    pm.status,
        'joinedAt',  to_char(pm.joined_at at time zone 'utc',
                             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      from public.project_memberships pm
      join project p on p.project_id = pm.project_id
      where pm.user_id = p_peer_user_id
    ),
    'ownerMembership', (
      select jsonb_build_object(
        'projectId', pm.project_id,
        'userId',    pm.user_id,
        'status',    pm.status,
        'joinedAt',  to_char(pm.joined_at at time zone 'utc',
                             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      from public.project_memberships pm
      join project p on p.project_id = pm.project_id
      where pm.user_id = p_owner_user_id
    ),
    'projectConnection', (
      -- The exact pair in either direction. Status is deliberately not
      -- filtered: a pending or revoked connection must reach the policy layer
      -- rather than look like an absent one.
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
      )
      from public.project_connections conn
      join project p on p.project_id = conn.project_id
      where (conn.requester_user_id = p_peer_user_id
             and conn.recipient_user_id = p_owner_user_id)
         or (conn.requester_user_id = p_owner_user_id
             and conn.recipient_user_id = p_peer_user_id)
    ),
    'ownerRuntimeBinding', (
      select jsonb_build_object(
        'runtimeBindingId',   rb.runtime_binding_id,
        'userId',             rb.user_id,
        'projectId',          rb.project_id,
        'githubRepositoryId', rb.github_repository_id::text,
        'status',             rb.status
      )
      from public.runtime_bindings rb
      join project p on p.project_id = rb.project_id
      where rb.user_id = p_owner_user_id
    ),
    'grant', (
      -- Looked up by identifier alone. Comparing owner, peer, task and
      -- resource here would collapse a mismatched grant into an absent one and
      -- hide a scope inconsistency the service must be able to see.
      select jsonb_build_object(
        'grantId',          g.grant_id,
        'taskId',           g.task_id,
        'ownerUserId',      g.owner_user_id,
        'peerUserId',       g.peer_user_id,
        'resourceId',       g.resource_id,
        'operation',        g.operation,
        'mode',             g.grant_mode,
        'status',           g.status,
        'grantedByUserId',  g.granted_by_user_id,
        'grantedAt',        to_char(g.granted_at at time zone 'utc',
                                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'expiresAt',        to_char(g.expires_at at time zone 'utc',
                                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'consumedAt',       to_char(g.consumed_at at time zone 'utc',
                                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'revokedAt',        to_char(g.revoked_at at time zone 'utc',
                                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      from public.resource_capability_grants g
      where g.grant_id = p_grant_id
    )
  );
$$;

revoke all on function public.load_capability_route_authorization_snapshot(
  uuid, uuid, bigint, uuid, uuid, uuid
) from public, anon, authenticated;

grant execute on function public.load_capability_route_authorization_snapshot(
  uuid, uuid, bigint, uuid, uuid, uuid
) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Grant write
-- ---------------------------------------------------------------------------
-- Records authority a human has just delegated. The resource identifier is
-- minted by the owner's connector first and passed in: the cloud can route an
-- identifier but must never be able to invent one, because inventing one would
-- mean naming a file no human selected.
create or replace function public.record_capability_grant(
  p_grant_id      uuid,
  p_task_id       uuid,
  p_owner_user_id uuid,
  p_peer_user_id  uuid,
  p_resource_id   text,
  p_grant_mode    text,
  p_expires_at    timestamptz
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_task     public.collaboration_tasks;
  v_existing public.resource_capability_grants;
  v_now      timestamptz := now();
  v_expires  timestamptz;
begin
  if p_grant_mode not in ('once', 'task')
     or p_resource_id !~ '^resource_[A-Za-z0-9_-]{16,120}$' then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  select * into v_task
  from public.collaboration_tasks t
  where t.task_id = p_task_id
  for update;

  if not found or v_task.status <> 'active' or v_task.expires_at <= v_now then
    return jsonb_build_object('outcome', 'task_unavailable');
  end if;

  -- The grant must be between exactly the two peers of the task it is scoped
  -- to, and the owner must be one of them.
  if not (
    (v_task.requester_user_id = p_peer_user_id
      and v_task.responder_user_id = p_owner_user_id)
    or
    (v_task.responder_user_id = p_peer_user_id
      and v_task.requester_user_id = p_owner_user_id)
  ) then
    return jsonb_build_object('outcome', 'task_unavailable');
  end if;

  -- Authority can never outlive the collaboration it was granted inside.
  v_expires := least(coalesce(p_expires_at, v_task.expires_at), v_task.expires_at);
  if v_expires <= v_now then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  select * into v_existing
  from public.resource_capability_grants g
  where g.task_id = p_task_id
    and g.owner_user_id = p_owner_user_id
    and g.peer_user_id = p_peer_user_id
    and g.resource_id = p_resource_id
    and g.operation = 'read'
    and g.status = 'active'
  for update;

  if found then
    -- Approving the same file twice in one task must not fragment authority
    -- into two rows. The human's latest choice replaces the earlier one, still
    -- bounded by the task.
    update public.resource_capability_grants
       set grant_mode = p_grant_mode,
           expires_at = v_expires
     where grant_id = v_existing.grant_id;
    return jsonb_build_object('outcome', 'existing', 'grantId', v_existing.grant_id);
  end if;

  insert into public.resource_capability_grants (
    grant_id, task_id, owner_user_id, peer_user_id, resource_id, operation,
    grant_mode, status, granted_by_user_id, granted_at, expires_at,
    consumed_at, revoked_at
  ) values (
    p_grant_id, p_task_id, p_owner_user_id, p_peer_user_id, p_resource_id, 'read',
    p_grant_mode, 'active', p_owner_user_id, v_now, v_expires,
    null, null
  );
  return jsonb_build_object('outcome', 'granted', 'grantId', p_grant_id);
end;
$$;

revoke all on function public.record_capability_grant(
  uuid, uuid, uuid, uuid, text, text, timestamptz
) from public, anon, authenticated;

grant execute on function public.record_capability_grant(
  uuid, uuid, uuid, uuid, text, text, timestamptz
) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Grant redemption
-- ---------------------------------------------------------------------------
-- Redeems one grant atomically. The row lock is what makes "Allow once" mean
-- once: two concurrent rounds racing the same grant serialize here, and the
-- loser sees a consumed grant rather than a second read.
--
-- Time comes from the database, not from a caller, so no request can move the
-- clock a grant expires against.
create or replace function public.consume_capability_grant(
  p_grant_id      uuid,
  p_owner_user_id uuid,
  p_peer_user_id  uuid,
  p_resource_id   text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_grant public.resource_capability_grants;
  v_now   timestamptz := now();
begin
  select * into v_grant
  from public.resource_capability_grants g
  where g.grant_id = p_grant_id
  for update;

  -- One outcome for every way a grant can fail to apply. Distinguishing them
  -- here would let a peer probe which grants exist for other resources.
  if not found
     or v_grant.owner_user_id <> p_owner_user_id
     or v_grant.peer_user_id <> p_peer_user_id
     or v_grant.resource_id <> p_resource_id
     or v_grant.operation <> 'read'
     or v_grant.status <> 'active' then
    return jsonb_build_object('outcome', 'unavailable');
  end if;

  if v_grant.expires_at <= v_now then
    update public.resource_capability_grants
       set status = 'expired'
     where grant_id = p_grant_id;
    return jsonb_build_object('outcome', 'expired');
  end if;

  if v_grant.grant_mode = 'once' then
    update public.resource_capability_grants
       set status = 'consumed',
           -- Never earlier than granted_at, so a backwards clock cannot violate
           -- the row's own time ordering.
           consumed_at = greatest(v_now, v_grant.granted_at)
     where grant_id = p_grant_id;
    return jsonb_build_object('outcome', 'consumed', 'mode', 'once');
  end if;

  return jsonb_build_object('outcome', 'reusable', 'mode', 'task');
end;
$$;

revoke all on function public.consume_capability_grant(
  uuid, uuid, uuid, text
) from public, anon, authenticated;

grant execute on function public.consume_capability_grant(
  uuid, uuid, uuid, text
) to service_role;
