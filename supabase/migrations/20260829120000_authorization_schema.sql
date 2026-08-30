-- Private-runtime authorization schema and snapshot RPC.
--
-- Mirrors apps/server/src/authorization/types.ts. Every table corresponds to
-- exactly one domain record; the snapshot RPC returns the eight keys of
-- PrivateRuntimeAuthorizationSnapshot in a single statement.
--
-- Deliberate properties, agreed with Khoa:
--   * github_repository_id and github_user_id are positive signed BIGINT in
--     Postgres and are returned as canonical decimal text.
--   * Statuses are TEXT with strict CHECK constraints, never enums.
--   * The RPC returns pending, inactive, unavailable and revoked records.
--     Authorization policy lives in the service, not in SQL. SQL only scopes
--     by the requested user, repository, project and conversation.
--   * No table holds credentials, tokens, session references, prompts,
--     drafts or private model output.

-- ---------------------------------------------------------------------------
-- Parameter domain
-- ---------------------------------------------------------------------------
-- Validates 1 <= p_max_project_connections <= 100 at call time while keeping
-- the RPC a single pure-SQL statement (SQL functions cannot RAISE).
create domain public.authz_connection_limit as integer
  check (value is not null and value between 1 and 100);

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.user_accounts (
  user_id    uuid primary key references auth.users (id) on delete restrict,
  status     text not null check (status in ('active', 'disabled', 'deleted')),
  created_at timestamptz not null default now()
);

create table public.github_connections (
  github_connection_id uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.user_accounts (user_id) on delete restrict,
  github_user_id       bigint not null check (github_user_id > 0),
  github_login         text not null check (length(btrim(github_login)) > 0),
  status               text not null check (status in
                         ('connecting', 'connected', 'reconnect_required', 'unavailable', 'revoked')),
  connected_at         timestamptz not null default now(),
  last_verified_at     timestamptz,
  revoked_at           timestamptz,
  -- One durable row per logical connection; status is updated in place.
  constraint github_connections_one_per_user unique (user_id),
  constraint github_connections_one_per_github_user unique (github_user_id),
  -- Referenced by github_repository_access to prove owner consistency.
  constraint github_connections_user_connection unique (user_id, github_connection_id),
  constraint github_connections_revoked_at_state check (
    (status = 'revoked' and revoked_at is not null) or
    (status <> 'revoked' and revoked_at is null)
  )
);

create table public.github_repository_access (
  user_id              uuid not null,
  github_connection_id uuid not null,
  github_repository_id bigint not null check (github_repository_id > 0),
  status               text not null check (status in
                         ('verified', 'revalidation_required', 'revoked')),
  verified_at          timestamptz not null,
  revoked_at           timestamptz,
  primary key (user_id, github_repository_id),
  -- The access proof must belong to that same user's own GitHub connection.
  constraint github_repository_access_connection_fk
    foreign key (user_id, github_connection_id)
    references public.github_connections (user_id, github_connection_id) on delete restrict,
  constraint github_repository_access_revoked_at_state check (
    (status = 'revoked' and revoked_at is not null) or
    (status <> 'revoked' and revoked_at is null)
  )
);

create table public.repository_projects (
  project_id           uuid primary key default gen_random_uuid(),
  github_repository_id bigint not null unique check (github_repository_id > 0),
  repository_full_name text not null check (length(btrim(repository_full_name)) > 0),
  visibility           text not null check (visibility in ('public', 'private', 'internal')),
  default_branch       text not null check (length(btrim(default_branch)) > 0),
  status               text not null check (status in ('active', 'archived')),
  -- Referenced by runtime_bindings to prove project/repository consistency.
  constraint repository_projects_project_repository unique (project_id, github_repository_id)
);

create table public.project_memberships (
  project_id uuid not null references public.repository_projects (project_id) on delete restrict,
  user_id    uuid not null references public.user_accounts (user_id) on delete restrict,
  status     text not null check (status in ('active', 'suspended', 'revoked')),
  joined_at  timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (project_id, user_id),
  constraint project_memberships_revoked_at_state check (
    (status = 'revoked' and revoked_at is not null) or
    (status <> 'revoked' and revoked_at is null)
  )
);

create table public.project_connections (
  project_connection_id uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.repository_projects (project_id) on delete restrict,
  requester_user_id     uuid not null,
  recipient_user_id     uuid not null,
  status                text not null check (status in ('pending', 'connected', 'revoked')),
  requested_at          timestamptz not null default now(),
  accepted_at           timestamptz,
  revoked_at            timestamptz,
  constraint project_connections_distinct_users check (requester_user_id <> recipient_user_id),
  -- Mirrors the ProjectConnection discriminated union so a malformed row
  -- cannot reach the domain mapper.
  constraint project_connections_state check (
    (status = 'pending'   and accepted_at is null     and revoked_at is null) or
    (status = 'connected' and accepted_at is not null and revoked_at is null) or
    (status = 'revoked'   and revoked_at is not null)
  ),
  -- Both sides must be members of this same project.
  constraint project_connections_requester_membership_fk
    foreign key (project_id, requester_user_id)
    references public.project_memberships (project_id, user_id) on delete restrict,
  constraint project_connections_recipient_membership_fk
    foreign key (project_id, recipient_user_id)
    references public.project_memberships (project_id, user_id) on delete restrict
);

-- One durable row per unordered pair per project; status is updated in place.
create unique index project_connections_one_per_pair
  on public.project_connections (
    project_id,
    least(requester_user_id, recipient_user_id),
    greatest(requester_user_id, recipient_user_id)
  );

create index project_connections_by_recipient
  on public.project_connections (project_id, recipient_user_id);

create index project_connections_by_requester
  on public.project_connections (project_id, requester_user_id);

create table public.project_conversations (
  conversation_id uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.repository_projects (project_id) on delete restrict,
  status          text not null check (status in ('active', 'closed'))
);

create index project_conversations_by_project
  on public.project_conversations (project_id);

create table public.conversation_participants (
  conversation_id uuid not null references public.project_conversations (conversation_id) on delete restrict,
  user_id         uuid not null references public.user_accounts (user_id) on delete restrict,
  primary key (conversation_id, user_id)
);

create table public.runtime_bindings (
  runtime_binding_id   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.user_accounts (user_id) on delete restrict,
  project_id           uuid not null,
  github_repository_id bigint not null check (github_repository_id > 0),
  status               text not null check (status in
                         ('provisioning', 'ready', 'stopped', 'unavailable', 'revoked')),
  -- Opaque cloud binding only. The local connector owns the private mapping
  -- to a workspace/provider; paths and credentials never enter Postgres.
  constraint runtime_bindings_one_per_user_project unique (user_id, project_id),
  -- The binding's repository must be the project's repository.
  constraint runtime_bindings_project_repository_fk
    foreign key (project_id, github_repository_id)
    references public.repository_projects (project_id, github_repository_id) on delete restrict
);

-- ---------------------------------------------------------------------------
-- Row level security: enabled everywhere, no browser policies.
-- ---------------------------------------------------------------------------
alter table public.user_accounts             enable row level security;
alter table public.github_connections        enable row level security;
alter table public.github_repository_access  enable row level security;
alter table public.repository_projects       enable row level security;
alter table public.project_memberships       enable row level security;
alter table public.project_connections       enable row level security;
alter table public.project_conversations     enable row level security;
alter table public.conversation_participants enable row level security;
alter table public.runtime_bindings          enable row level security;

revoke all on table
  public.user_accounts,
  public.github_connections,
  public.github_repository_access,
  public.repository_projects,
  public.project_memberships,
  public.project_connections,
  public.project_conversations,
  public.conversation_participants,
  public.runtime_bindings
from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Snapshot RPC
-- ---------------------------------------------------------------------------
create function public.load_private_runtime_authorization_snapshot(
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
        'conversationId',     pc.conversation_id,
        'projectId',          pc.project_id,
        'participantUserIds', coalesce((
          select jsonb_agg(cp.user_id order by cp.user_id)
          from public.conversation_participants cp
          where cp.conversation_id = pc.conversation_id
        ), '[]'::jsonb),
        'status',             pc.status
      )
      from public.project_conversations pc
      join project p on p.project_id = pc.project_id
      where pc.conversation_id = p_conversation_id
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
        where conn.requester_user_id = p_user_id
           or conn.recipient_user_id = p_user_id
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

revoke all on function public.load_private_runtime_authorization_snapshot(
  uuid, bigint, uuid, public.authz_connection_limit
) from public, anon, authenticated;

grant execute on function public.load_private_runtime_authorization_snapshot(
  uuid, bigint, uuid, public.authz_connection_limit
) to service_role;
