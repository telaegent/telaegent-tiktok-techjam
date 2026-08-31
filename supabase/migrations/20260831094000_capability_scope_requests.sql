-- The scope-expansion queue (build plan 8.1).
--
-- A peer's agent may ask for a file it was never given. Asking is not getting:
-- the request waits here until the owning human presses Deny, Allow once, or
-- Allow for this task. Nothing in this table is authority; approving a row is
-- what creates authority, in resource_capability_grants.
--
-- What is stored is what the peer said and the opaque identifier the owner's
-- connector minted for the file it resolved locally. The canonical path is not
-- here and never can be: the cloud routes an identifier it cannot invent.

create table public.capability_scope_requests (
  scope_request_id      uuid primary key,
  task_id               uuid not null
                          references public.collaboration_tasks (task_id)
                          on delete restrict,
  -- The human who decides. Always the owner of the repository being read.
  owner_user_id         uuid not null
                          references public.user_accounts (user_id)
                          on delete restrict,
  -- The peer whose agent asked, and who would receive the bytes.
  peer_user_id          uuid not null
                          references public.user_accounts (user_id)
                          on delete restrict,
  -- The peer's own words, shown to the owning human so they can judge the ask.
  -- A guess about the owner's repository, never a resolved location in it.
  requested_hint        text
                          check (
                            requested_hint is null
                            or (length(requested_hint) between 1 and 512
                                and requested_hint !~ '[[:cntrl:]]')
                          ),
  requested_reason      text not null
                          check (length(requested_reason) between 1 and 2000),
  -- Minted by the owner's connector before this row could exist.
  candidate_resource_id text not null
                          check (candidate_resource_id ~ '^resource_[A-Za-z0-9_-]{16,120}$'),
  status                text not null
                          check (status in ('pending', 'approved', 'denied')),
  -- Which button the human pressed. Absent for a denial: a denial grants
  -- nothing, so it has no mode.
  decision              text check (decision in ('once', 'task')),
  grant_id              uuid
                          references public.resource_capability_grants (grant_id)
                          on delete restrict,
  requested_at          timestamptz not null,
  decided_at            timestamptz,
  constraint capability_scope_requests_distinct_peers check (
    owner_user_id <> peer_user_id
  ),
  constraint capability_scope_requests_time_order check (
    decided_at is null or decided_at >= requested_at
  ),
  constraint capability_scope_requests_status_shape check (
    (status = 'pending' and decision is null and grant_id is null
      and decided_at is null)
    or
    (status = 'approved' and decision is not null and grant_id is not null
      and decided_at is not null)
    or
    (status = 'denied' and decision is null and grant_id is null
      and decided_at is not null)
  )
);

-- Build plan 8.7: identical pending requests are deduplicated, so a peer that
-- asks for the same file every round cannot bury a human in prompts.
create unique index capability_scope_requests_one_pending
  on public.capability_scope_requests (task_id, candidate_resource_id)
  where status = 'pending';

create index capability_scope_requests_owner_inbox
  on public.capability_scope_requests (owner_user_id, requested_at, scope_request_id)
  where status = 'pending';

alter table public.capability_scope_requests enable row level security;

revoke all on table public.capability_scope_requests from public, anon, authenticated;
grant select, insert, update on table public.capability_scope_requests to service_role;

-- Build plan 8.7 bounds the autonomous loop at five follow-up rounds. The bound
-- lives in the schema as well as the server so a server bug cannot exceed it.
alter table public.collaboration_tasks
  add column follow_up_rounds integer not null default 0
    check (follow_up_rounds between 0 and 5);

-- ---------------------------------------------------------------------------
-- 4. Queue a scope expansion for the owning human
-- ---------------------------------------------------------------------------
-- The candidate identifier is passed in because only the owner's connector can
-- produce one. A request the connector could not resolve to a safe file inside
-- the project never reaches this function, so no human is ever offered a button
-- that reads a secret or escapes the workspace.
create or replace function public.record_capability_scope_request(
  p_scope_request_id      uuid,
  p_task_id               uuid,
  p_owner_user_id         uuid,
  p_peer_user_id          uuid,
  p_requested_hint        text,
  p_requested_reason      text,
  p_candidate_resource_id text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_task     public.collaboration_tasks;
  v_existing public.capability_scope_requests;
  v_grant    public.resource_capability_grants;
  v_now      timestamptz := now();
begin
  if p_candidate_resource_id !~ '^resource_[A-Za-z0-9_-]{16,120}$'
     or p_requested_reason is null
     or length(p_requested_reason) not between 1 and 2000
     or (p_requested_hint is not null
         and (length(p_requested_hint) not between 1 and 512
              or p_requested_hint ~ '[[:cntrl:]]')) then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  select * into v_task
  from public.collaboration_tasks t
  where t.task_id = p_task_id
  for update;

  if not found or v_task.status <> 'active' or v_task.expires_at <= v_now then
    return jsonb_build_object('outcome', 'task_unavailable');
  end if;

  if not (
    (v_task.requester_user_id = p_peer_user_id
      and v_task.responder_user_id = p_owner_user_id)
    or
    (v_task.responder_user_id = p_peer_user_id
      and v_task.requester_user_id = p_owner_user_id)
  ) then
    return jsonb_build_object('outcome', 'task_unavailable');
  end if;

  -- Authority the human already delegated is not asked for again. This is the
  -- warm path: the peer simply did not know it still held the grant.
  select * into v_grant
  from public.resource_capability_grants g
  where g.task_id = p_task_id
    and g.owner_user_id = p_owner_user_id
    and g.peer_user_id = p_peer_user_id
    and g.resource_id = p_candidate_resource_id
    and g.operation = 'read'
    and g.status = 'active'
    and g.expires_at > v_now;

  if found then
    return jsonb_build_object(
      'outcome', 'already_granted', 'grantId', v_grant.grant_id
    );
  end if;

  select * into v_existing
  from public.capability_scope_requests r
  where r.task_id = p_task_id
    and r.candidate_resource_id = p_candidate_resource_id
    and r.status = 'pending'
  for update;

  if found then
    return jsonb_build_object(
      'outcome', 'existing', 'scopeRequestId', v_existing.scope_request_id
    );
  end if;

  insert into public.capability_scope_requests (
    scope_request_id, task_id, owner_user_id, peer_user_id, requested_hint,
    requested_reason, candidate_resource_id, status, decision, grant_id,
    requested_at, decided_at
  ) values (
    p_scope_request_id, p_task_id, p_owner_user_id, p_peer_user_id,
    p_requested_hint, p_requested_reason, p_candidate_resource_id,
    'pending', null, null, v_now, null
  );
  return jsonb_build_object('outcome', 'recorded', 'scopeRequestId', p_scope_request_id);
end;
$$;

revoke all on function public.record_capability_scope_request(
  uuid, uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;

grant execute on function public.record_capability_scope_request(
  uuid, uuid, uuid, uuid, text, text, text
) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Record the human's decision
-- ---------------------------------------------------------------------------
-- Deny, Allow once, Allow for this task. Only the owner named on the request
-- may answer it, and only once: the row lock makes a double-click a single
-- decision rather than two grants.
create or replace function public.decide_capability_scope_request(
  p_scope_request_id uuid,
  p_owner_user_id    uuid,
  p_decision         text,
  p_grant_id         uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_request public.capability_scope_requests;
  v_grant   jsonb;
  v_now     timestamptz := now();
begin
  if p_decision not in ('deny', 'once', 'task') then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  select * into v_request
  from public.capability_scope_requests r
  where r.scope_request_id = p_scope_request_id
  for update;

  -- One word for every way this can fail. A caller who is not the owner learns
  -- nothing about whether the request exists.
  if not found
     or v_request.status <> 'pending'
     or v_request.owner_user_id <> p_owner_user_id then
    return jsonb_build_object('outcome', 'unavailable');
  end if;

  if p_decision = 'deny' then
    update public.capability_scope_requests
       set status = 'denied', decided_at = v_now
     where scope_request_id = p_scope_request_id;
    return jsonb_build_object('outcome', 'denied');
  end if;

  -- Approval creates authority through the one function that may: the grant
  -- table is never written directly from here, so every bound it enforces
  -- (task membership, expiry clamping, one active row per scope) still holds.
  v_grant := public.record_capability_grant(
    p_grant_id,
    v_request.task_id,
    v_request.owner_user_id,
    v_request.peer_user_id,
    v_request.candidate_resource_id,
    p_decision,
    null
  );

  if v_grant->>'outcome' not in ('granted', 'existing') then
    return v_grant;
  end if;

  update public.capability_scope_requests
     set status = 'approved',
         decision = p_decision,
         grant_id = (v_grant->>'grantId')::uuid,
         decided_at = v_now
   where scope_request_id = p_scope_request_id;

  return jsonb_build_object(
    'outcome', 'approved',
    'grantId', v_grant->>'grantId',
    'mode', p_decision
  );
end;
$$;

revoke all on function public.decide_capability_scope_request(
  uuid, uuid, text, uuid
) from public, anon, authenticated;

grant execute on function public.decide_capability_scope_request(
  uuid, uuid, text, uuid
) to service_role;

-- ---------------------------------------------------------------------------
-- 6. The owner's pending queue
-- ---------------------------------------------------------------------------
-- Scoped by repository, because repository ID is the scope boundary: a pending
-- request raised inside repo A is invisible while looking at repo B.
create or replace function public.list_pending_capability_scope_requests(
  p_owner_user_id        uuid,
  p_github_repository_id bigint
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'scopeRequestId', r.scope_request_id,
        'taskId', r.task_id,
        'conversationId', t.conversation_id,
        -- Decimal text, because a bigint repository id does not survive a JSON
        -- number intact.
        'githubRepositoryId', t.github_repository_id::text,
        'peerUserId', r.peer_user_id,
        'requestedHint', r.requested_hint,
        'requestedReason', r.requested_reason,
        'candidateResourceId', r.candidate_resource_id,
        -- Stated, never inferred: this queue can only ever offer reads.
        'operation', 'read',
        'requestedAt', to_char(r.requested_at at time zone 'utc',
                               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'taskExpiresAt', to_char(t.expires_at at time zone 'utc',
                                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      order by r.requested_at, r.scope_request_id
    ),
    '[]'::jsonb
  )
  from public.capability_scope_requests r
  join public.collaboration_tasks t on t.task_id = r.task_id
  where r.owner_user_id = p_owner_user_id
    and r.status = 'pending'
    and t.github_repository_id = p_github_repository_id
    -- A dead task cannot be approved into, so it is not shown either.
    and t.status = 'active'
    and t.expires_at > now();
$$;

revoke all on function public.list_pending_capability_scope_requests(uuid, bigint)
  from public, anon, authenticated;

grant execute on function public.list_pending_capability_scope_requests(uuid, bigint)
  to service_role;

-- ---------------------------------------------------------------------------
-- 7. Spend one follow-up round
-- ---------------------------------------------------------------------------
-- Build plan 8.7. The counter is the loop's stopping condition: a pair of
-- agents that keep asking each other for one more file run out of rounds
-- rather than running forever.
create or replace function public.begin_capability_follow_up_round(
  p_task_id       uuid,
  p_owner_user_id uuid,
  p_peer_user_id  uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_task public.collaboration_tasks;
  v_now  timestamptz := now();
begin
  select * into v_task
  from public.collaboration_tasks t
  where t.task_id = p_task_id
  for update;

  if not found or v_task.status <> 'active' or v_task.expires_at <= v_now then
    return jsonb_build_object('outcome', 'task_unavailable');
  end if;

  if not (
    (v_task.requester_user_id = p_peer_user_id
      and v_task.responder_user_id = p_owner_user_id)
    or
    (v_task.responder_user_id = p_peer_user_id
      and v_task.requester_user_id = p_owner_user_id)
  ) then
    return jsonb_build_object('outcome', 'task_unavailable');
  end if;

  if v_task.follow_up_rounds >= 5 then
    return jsonb_build_object('outcome', 'exhausted', 'round', v_task.follow_up_rounds);
  end if;

  update public.collaboration_tasks
     set follow_up_rounds = follow_up_rounds + 1
   where task_id = p_task_id;

  return jsonb_build_object('outcome', 'started', 'round', v_task.follow_up_rounds + 1);
end;
$$;

revoke all on function public.begin_capability_follow_up_round(uuid, uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.begin_capability_follow_up_round(uuid, uuid, uuid)
  to service_role;
