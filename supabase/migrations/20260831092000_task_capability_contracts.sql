-- Durable cloud-safe contracts for bounded collaboration tasks and exact
-- read-only capability grants. These tables intentionally contain no local
-- paths, file contents, credentials, provider sessions, commands or write
-- authority. The owner's local connector remains the final reference monitor.

create table public.collaboration_tasks (
  task_id                   uuid primary key,
  project_id                uuid not null
                              references public.repository_projects (project_id)
                              on delete restrict,
  conversation_id           uuid not null
                              references public.project_conversations (conversation_id)
                              on delete restrict,
  github_repository_id      bigint not null check (github_repository_id > 0),
  requester_user_id         uuid not null
                              references public.user_accounts (user_id)
                              on delete restrict,
  responder_user_id         uuid not null
                              references public.user_accounts (user_id)
                              on delete restrict,
  origin_shared_message_id  uuid not null unique
                              references public.shared_messages (message_id)
                              on delete restrict,
  status                    text not null
                              check (status in ('active', 'completed', 'cancelled')),
  created_at                timestamptz not null,
  expires_at                timestamptz not null,
  ended_at                  timestamptz,
  constraint collaboration_tasks_distinct_peers check (
    requester_user_id <> responder_user_id
  ),
  constraint collaboration_tasks_time_order check (
    expires_at > created_at and
    (ended_at is null or ended_at >= created_at)
  ),
  constraint collaboration_tasks_status_shape check (
    (status = 'active' and ended_at is null)
    or
    (status in ('completed', 'cancelled') and ended_at is not null)
  )
);

create index collaboration_tasks_by_conversation
  on public.collaboration_tasks (conversation_id, created_at, task_id);

create index collaboration_tasks_active_expiry
  on public.collaboration_tasks (expires_at)
  where status = 'active';

create table public.resource_capability_grants (
  grant_id          uuid primary key,
  task_id           uuid not null
                      references public.collaboration_tasks (task_id)
                      on delete restrict,
  owner_user_id     uuid not null
                      references public.user_accounts (user_id)
                      on delete restrict,
  peer_user_id      uuid not null
                      references public.user_accounts (user_id)
                      on delete restrict,
  -- Opaque identifier only. The connector-local registry owns its path.
  resource_id       text not null
                      check (resource_id ~ '^resource_[A-Za-z0-9_-]{16,120}$'),
  operation         text not null check (operation = 'read'),
  grant_mode        text not null check (grant_mode in ('once', 'task')),
  status            text not null
                      check (status in ('active', 'consumed', 'revoked', 'expired')),
  granted_by_user_id uuid not null
                      references public.user_accounts (user_id)
                      on delete restrict,
  granted_at        timestamptz not null,
  expires_at        timestamptz not null,
  consumed_at       timestamptz,
  revoked_at        timestamptz,
  constraint resource_capability_grants_distinct_peers check (
    owner_user_id <> peer_user_id
  ),
  constraint resource_capability_grants_owner_issued check (
    granted_by_user_id = owner_user_id
  ),
  constraint resource_capability_grants_time_order check (
    expires_at > granted_at and
    (consumed_at is null or consumed_at >= granted_at) and
    (revoked_at is null or revoked_at >= granted_at)
  ),
  constraint resource_capability_grants_status_shape check (
    (status = 'active' and consumed_at is null and revoked_at is null)
    or
    (status = 'consumed' and grant_mode = 'once' and consumed_at is not null
      and revoked_at is null)
    or
    (status = 'revoked' and revoked_at is not null)
    or
    (status = 'expired' and consumed_at is null and revoked_at is null)
  )
);

-- At most one currently reusable grant for the same exact authority tuple.
-- Historical consumed/revoked/expired grants remain immutable audit evidence.
create unique index resource_capability_grants_one_active_scope
  on public.resource_capability_grants (
    task_id, owner_user_id, peer_user_id, resource_id, operation
  )
  where status = 'active';

create index resource_capability_grants_active_expiry
  on public.resource_capability_grants (expires_at)
  where status = 'active';

alter table public.collaboration_tasks enable row level security;
alter table public.resource_capability_grants enable row level security;

revoke all on table public.collaboration_tasks from public, anon, authenticated;
revoke all on table public.resource_capability_grants from public, anon, authenticated;

grant select, insert, update on table public.collaboration_tasks to service_role;
grant select, insert, update on table public.resource_capability_grants to service_role;
