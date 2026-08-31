-- Project-scoped collaborator connections and conversation creation.
--
-- `project_connections`, `project_conversations`, and `conversation_participants`
-- have existed since the authorization schema, but nothing could write them. A
-- conversation had to be seeded by hand before any draft could be opened, so the
-- product's defining interaction -- two independently owned agents talking about
-- one repository -- was unreachable through the API.
--
-- These functions close that gap. They are the only writers of collaborator
-- trust, and each one re-derives authority from scratch rather than trusting the
-- caller's claim:
--
--   * eligibility is mutual proof of repository access, never one user
--     enumerating GitHub collaborators (GITHUB_CONNECTION_DESIGN section 6);
--   * a connection is scoped to one project and is revocable by either side;
--   * a conversation may only exist between two already-connected members.
--
-- Nothing here grants repository, filesystem, runtime, or private-draft access.
-- A connection grants the right to *request* communication. Every message still
-- crosses only on its owner's Send.

-- No new tables or indexes. The three tables written here have existed since
-- the authorization schema, and peer lookup by project is already served by
-- project_memberships' (project_id, user_id) primary key.

-- ---------------------------------------------------------------------------
-- Discovery
-- ---------------------------------------------------------------------------
-- Peers who independently proved access to the same repository.
--
-- Both sides must hold `verified` repository access from their own GitHub
-- connection. One user's proof never establishes another's, so a peer whose
-- access is stale, revalidation_required, or revoked is not listed at all --
-- they are not yet eligible to be asked.
--
-- The response carries the peer's user ID, their GitHub login, and the state of
-- any connection between the two. It carries no repository, path, binding,
-- credential, provider, or conversation detail: this endpoint answers "who could
-- I ask?", nothing more.
create or replace function public.list_project_collaborators(
  p_user_id    uuid,
  p_project_id uuid,
  p_limit      integer
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when p_limit is null or p_limit not between 1 and 51 or
         -- The caller must themselves be an active, access-verified member.
         -- Discovery is a project-scoped read, not a directory lookup.
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
        order by listed.github_login
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
        -- Mutual proof: the peer's own verified access to this repository.
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
        order by identity.github_login
        limit p_limit
      ) listed
    ), '[]'::jsonb)
  end;
$$;

revoke all on function public.list_project_collaborators(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.list_project_collaborators(uuid, uuid, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- Connection lifecycle
-- ---------------------------------------------------------------------------
-- Shared projection so every lifecycle function returns the same shape.
create or replace function public.project_connection_json(
  connection public.project_connections
)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'projectConnectionId', connection.project_connection_id::text,
    'projectId', connection.project_id::text,
    'requesterUserId', connection.requester_user_id::text,
    'recipientUserId', connection.recipient_user_id::text,
    'status', connection.status,
    'requestedAt', to_char(
      connection.requested_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'acceptedAt', case
      when connection.accepted_at is null then null
      else to_char(
        connection.accepted_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    end,
    'revokedAt', case
      when connection.revoked_at is null then null
      else to_char(
        connection.revoked_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    end
  );
$$;

revoke all on function public.project_connection_json(public.project_connections)
  from public, anon, authenticated;
grant execute on function public.project_connection_json(public.project_connections)
  to service_role;

-- Ask a peer for a project-scoped connection.
--
-- Both sides must be active members with verified access to this project's
-- repository at request time. `project_connections_one_per_pair` keeps one
-- durable row per unordered pair per project, so a request after a revocation
-- reuses that row. A pair that is already pending or connected returns no row:
-- there is nothing to request, and the caller re-reads discovery to see why.
create or replace function public.request_project_connection(
  p_project_connection_id uuid,
  p_project_id            uuid,
  p_requester_user_id     uuid,
  p_recipient_user_id     uuid,
  p_requested_at          timestamptz
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  with eligible as (
    select project.project_id
    from public.repository_projects project
    join public.project_memberships requester
      on requester.project_id = project.project_id
     and requester.user_id = p_requester_user_id
     and requester.status = 'active'
    join public.project_memberships recipient
      on recipient.project_id = project.project_id
     and recipient.user_id = p_recipient_user_id
     and recipient.status = 'active'
    -- Mutual proof, re-derived now rather than trusted from discovery.
    join public.github_repository_access requester_access
      on requester_access.user_id = p_requester_user_id
     and requester_access.github_repository_id = project.github_repository_id
     and requester_access.status = 'verified'
    join public.github_repository_access recipient_access
      on recipient_access.user_id = p_recipient_user_id
     and recipient_access.github_repository_id = project.github_repository_id
     and recipient_access.status = 'verified'
    where project.project_id = p_project_id
      and project.status = 'active'
      and p_requester_user_id <> p_recipient_user_id
  ),
  requested as (
    insert into public.project_connections as existing (
      project_connection_id, project_id, requester_user_id, recipient_user_id,
      status, requested_at, accepted_at, revoked_at
    )
    select
      p_project_connection_id, eligible.project_id, p_requester_user_id,
      p_recipient_user_id, 'pending', p_requested_at, null, null
    from eligible
    on conflict (
      project_id,
      least(requester_user_id, recipient_user_id),
      greatest(requester_user_id, recipient_user_id)
    )
    do update set
      requester_user_id = excluded.requester_user_id,
      recipient_user_id = excluded.recipient_user_id,
      status            = 'pending',
      requested_at      = excluded.requested_at,
      accepted_at       = null,
      revoked_at        = null
    -- Only a revoked pair may be asked again. Pending and connected pairs are
    -- left exactly as they are.
    where existing.status = 'revoked'
    -- Whole-row RETURNING yields the table's composite type, which the shared
    -- projection accepts; `existing.*` would decompose into an anonymous record.
    returning existing
  )
  select public.project_connection_json(c.existing) from requested c;
$$;

revoke all on function public.request_project_connection(
  uuid, uuid, uuid, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.request_project_connection(
  uuid, uuid, uuid, uuid, timestamptz
) to service_role;

-- Accept or decline a pending request.
--
-- Only the named recipient may answer, and only while the row is still pending.
-- Accepting re-checks mutual proof: a request that sat while either side lost
-- repository access must not silently become a live connection. Declining needs
-- no such check -- refusing is always safe -- and lands on `revoked`, which is
-- the schema's terminal state for "not connected".
create or replace function public.respond_to_project_connection(
  p_project_connection_id uuid,
  p_recipient_user_id     uuid,
  p_decision              text,
  p_at                    timestamptz
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  with answerable as (
    select connection.project_connection_id
    from public.project_connections connection
    join public.repository_projects project
      on project.project_id = connection.project_id
     and project.status = 'active'
    join public.project_memberships recipient
      on recipient.project_id = connection.project_id
     and recipient.user_id = connection.recipient_user_id
     and recipient.status = 'active'
    where connection.project_connection_id = p_project_connection_id
      and connection.recipient_user_id = p_recipient_user_id
      and connection.status = 'pending'
      and p_decision in ('accept', 'decline')
      and (
        p_decision = 'decline'
        or (
          exists (
            select 1
            from public.project_memberships requester
            where requester.project_id = connection.project_id
              and requester.user_id = connection.requester_user_id
              and requester.status = 'active'
          )
          and exists (
            select 1
            from public.github_repository_access access
            where access.user_id = connection.requester_user_id
              and access.github_repository_id = project.github_repository_id
              and access.status = 'verified'
          )
          and exists (
            select 1
            from public.github_repository_access access
            where access.user_id = connection.recipient_user_id
              and access.github_repository_id = project.github_repository_id
              and access.status = 'verified'
          )
        )
      )
  ),
  answered as (
    update public.project_connections connection
    set status      = case when p_decision = 'accept' then 'connected' else 'revoked' end,
        accepted_at = case when p_decision = 'accept' then p_at else connection.accepted_at end,
        revoked_at  = case when p_decision = 'accept' then connection.revoked_at else p_at end
    from answerable
    where connection.project_connection_id = answerable.project_connection_id
    returning connection
  )
  select public.project_connection_json(c.connection) from answered c;
$$;

revoke all on function public.respond_to_project_connection(
  uuid, uuid, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.respond_to_project_connection(
  uuid, uuid, text, timestamptz
) to service_role;

-- Withdraw or revoke a connection.
--
-- Either side may do this, from `pending` or `connected`, and it is deliberately
-- unconditional on repository access: losing access must never trap a user in a
-- connection they want gone. Existing conversations are left in place; what
-- stops is new cross-agent work, because every conversation action re-reads
-- this row and refuses when it is not `connected`.
create or replace function public.revoke_project_connection(
  p_project_connection_id uuid,
  p_user_id               uuid,
  p_at                    timestamptz
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  with revoked as (
    update public.project_connections connection
    set status     = 'revoked',
        revoked_at = p_at
    where connection.project_connection_id = p_project_connection_id
      and connection.status in ('pending', 'connected')
      and p_user_id in (connection.requester_user_id, connection.recipient_user_id)
    returning connection
  )
  select public.project_connection_json(c.connection) from revoked c;
$$;

revoke all on function public.revoke_project_connection(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.revoke_project_connection(uuid, uuid, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- Conversation creation
-- ---------------------------------------------------------------------------
-- Open the shared conversation for one connected pair.
--
-- This is the last missing link in the round trip: drafts, replies, and sends
-- all address a conversation that previously had no way to exist.
--
-- The pair must be `connected` on this project *now*. Creation is idempotent on
-- the pair -- a second call returns the conversation already open rather than
-- fragmenting the durable collaboration record across duplicates, which is what
-- makes it safe for the browser to call on entering a peer's thread.
create or replace function public.create_project_conversation(
  p_conversation_id uuid,
  p_project_id      uuid,
  p_user_id         uuid,
  p_peer_user_id    uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  with authorized as (
    select project.project_id, project.github_repository_id
    from public.repository_projects project
    join public.project_connections connection
      on connection.project_id = project.project_id
     and connection.status = 'connected'
     and least(connection.requester_user_id, connection.recipient_user_id)
         = least(p_user_id, p_peer_user_id)
     and greatest(connection.requester_user_id, connection.recipient_user_id)
         = greatest(p_user_id, p_peer_user_id)
    join public.project_memberships caller
      on caller.project_id = project.project_id
     and caller.user_id = p_user_id
     and caller.status = 'active'
    join public.project_memberships peer
      on peer.project_id = project.project_id
     and peer.user_id = p_peer_user_id
     and peer.status = 'active'
    where project.project_id = p_project_id
      and project.status = 'active'
      and p_user_id <> p_peer_user_id
  ),
  -- An active two-party conversation already open for exactly this pair.
  existing as (
    select conversation.conversation_id, conversation.project_id
    from public.project_conversations conversation
    join authorized on authorized.project_id = conversation.project_id
    where conversation.status = 'active'
      and (
        select count(*)
        from public.conversation_participants participant
        where participant.conversation_id = conversation.conversation_id
      ) = 2
      and exists (
        select 1
        from public.conversation_participants participant
        where participant.conversation_id = conversation.conversation_id
          and participant.user_id = p_user_id
      )
      and exists (
        select 1
        from public.conversation_participants participant
        where participant.conversation_id = conversation.conversation_id
          and participant.user_id = p_peer_user_id
      )
    order by conversation.conversation_id
    limit 1
  ),
  created as (
    insert into public.project_conversations (conversation_id, project_id, status)
    select p_conversation_id, authorized.project_id, 'active'
    from authorized
    where not exists (select 1 from existing)
    returning conversation_id, project_id
  ),
  -- Data-modifying CTEs run to completion whether or not the outer query reads
  -- them, so both participants land even though only `created` is selected.
  joined as (
    -- conversation_participants carries project_id so its membership FK can
    -- enforce, in the schema itself, that a participant is a project member.
    insert into public.conversation_participants (conversation_id, user_id, project_id)
    select created.conversation_id, participant.user_id, created.project_id
    from created
    cross join (
      select p_user_id as user_id
      union all
      select p_peer_user_id
    ) participant
    returning conversation_id
  )
  select jsonb_build_object(
    'conversationId', opened.conversation_id::text,
    'projectId', opened.project_id::text,
    'githubRepositoryId', authorized.github_repository_id::text,
    'status', 'active',
    'participantUserIds', jsonb_build_array(
      p_user_id::text, p_peer_user_id::text
    ),
    'created', opened.was_created
  )
  from authorized
  join (
    select conversation_id, project_id, true as was_created from created
    union all
    select conversation_id, project_id, false from existing
  ) opened on opened.project_id = authorized.project_id
  limit 1;
$$;

revoke all on function public.create_project_conversation(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.create_project_conversation(uuid, uuid, uuid, uuid)
  to service_role;
