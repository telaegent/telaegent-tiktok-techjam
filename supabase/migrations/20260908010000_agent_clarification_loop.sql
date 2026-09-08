-- Bilateral, task-scoped agent clarification.
--
-- This is deliberately additive and default-dark. The application feature
-- flag is off unless an operator enables it, while older servers/connectors
-- continue to ignore these tables and functions. Provider session IDs, local
-- paths, repository bytes and private reasoning are forbidden from this
-- schema. Question/answer payload is split from structural audit metadata so
-- it can be deleted on every terminal path and at the existing task expiry.

create table public.agent_dialogue_origin_grants (
  origin_shared_message_id uuid primary key
    references public.shared_messages (message_id) on delete restrict,
  grantor_user_id uuid not null
    references public.user_accounts (user_id) on delete restrict,
  provider text not null check (provider in ('codex', 'claude')),
  model text check (
    model is null or model ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  granted_at timestamptz not null,
  -- Consent expires on its own. Without this the grant written by `Send`
  -- outlived everything it was scoped to: the collaboration task it feeds dies
  -- after 60 minutes, but the grant sat unrevoked forever, so a recipient's
  -- agent could open an exchange against a message its author consented to on
  -- a different day. 'revoked_at' did not cover that window -- the only writers
  -- of it need a clarification task that does not exist yet.
  expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint agent_dialogue_origin_grant_time check (
    revoked_at is null or revoked_at >= granted_at
  ),
  constraint agent_dialogue_origin_grant_lifetime check (
    expires_at > granted_at
  )
);

create table public.agent_clarification_tasks (
  task_id uuid primary key
    references public.collaboration_tasks (task_id) on delete restrict,
  requester_provider text not null check (requester_provider in ('codex', 'claude')),
  requester_model text check (
    requester_model is null or requester_model ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  responder_provider text not null check (responder_provider in ('codex', 'claude')),
  responder_model text check (
    responder_model is null or responder_model ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  state text not null check (state in (
    'recipient_running', 'dialogue_running', 'human_required',
    'completed', 'cancelled', 'expired'
  )),
  questions_used integer not null default 0 check (questions_used between 0 and 2),
  version integer not null default 0 check (version >= 0),
  expected_user_id uuid references public.user_accounts (user_id) on delete restrict,
  expected_lane text check (
    expected_lane is null or expected_lane in (
      'private_work', 'clarification_dialogue', 'human'
    )
  ),
  current_step_id uuid,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint agent_clarification_terminal_shape check (
    state not in ('completed', 'cancelled', 'expired')
    or (expected_user_id is null and expected_lane is null and current_step_id is null)
  )
);

create table public.agent_clarification_steps (
  step_id uuid primary key,
  task_id uuid not null
    references public.agent_clarification_tasks (task_id) on delete restrict,
  parent_step_id uuid references public.agent_clarification_steps (step_id) on delete restrict,
  sequence integer not null check (sequence between 1 and 2),
  asked_by_user_id uuid not null references public.user_accounts (user_id) on delete restrict,
  asked_to_user_id uuid not null references public.user_accounts (user_id) on delete restrict,
  status text not null check (status in ('pending', 'human_required', 'resolved')),
  reason_code text check (
    reason_code is null or reason_code in (
      'ambiguity', 'contradiction', 'missing_intent'
    )
  ),
  shared_basis_message_ids uuid[] not null default '{}'::uuid[]
    check (cardinality(shared_basis_message_ids) <= 8),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  answer_hash text check (answer_hash is null or answer_hash ~ '^[0-9a-f]{64}$'),
  human_required_reason text check (
    human_required_reason is null or human_required_reason in (
      'new_authority', 'private_context', 'ambiguous', 'safety'
    )
  ),
  created_at timestamptz not null,
  resolved_at timestamptz,
  constraint agent_clarification_step_distinct_peers check (
    asked_by_user_id <> asked_to_user_id
  ),
  constraint agent_clarification_step_resolution_shape check (
    (status = 'pending' and answer_hash is null and human_required_reason is null and resolved_at is null)
    or (status = 'human_required' and answer_hash is null and human_required_reason is not null and resolved_at is null)
    or (status = 'resolved' and answer_hash is not null and human_required_reason is null and resolved_at is not null)
  ),
  unique (task_id, sequence)
);

alter table public.agent_clarification_tasks
  add constraint agent_clarification_current_step_fk
  foreign key (current_step_id)
  references public.agent_clarification_steps (step_id)
  deferrable initially deferred;

create table public.agent_clarification_payloads (
  step_id uuid primary key
    references public.agent_clarification_steps (step_id) on delete restrict,
  task_id uuid not null
    references public.agent_clarification_tasks (task_id) on delete restrict,
  question text not null check (octet_length(question) between 1 and 500),
  answer text check (answer is null or octet_length(answer) between 1 and 1500),
  expires_at timestamptz not null
);

create index agent_clarification_steps_by_task
  on public.agent_clarification_steps (task_id, sequence);
create index agent_clarification_payloads_expiry
  on public.agent_clarification_payloads (expires_at);

alter table public.agent_dialogue_origin_grants enable row level security;
alter table public.agent_clarification_tasks enable row level security;
alter table public.agent_clarification_steps enable row level security;
alter table public.agent_clarification_payloads enable row level security;

revoke all on table
  public.agent_dialogue_origin_grants,
  public.agent_clarification_tasks,
  public.agent_clarification_steps,
  public.agent_clarification_payloads
from public, anon, authenticated;

grant select, insert, update on table
  public.agent_dialogue_origin_grants,
  public.agent_clarification_tasks,
  public.agent_clarification_steps,
  public.agent_clarification_payloads
to service_role;
grant delete on table public.agent_clarification_payloads to service_role;

-- Retention, not access control.
--
-- Every RPC below already refuses an expired task, and the ones that touch a
-- task delete its payloads on the way past. That is enough to stop an expired
-- exchange being read, and not enough to stop it being stored: a task both
-- people abandon is never touched again, so its rows -- the only cross-user
-- question and answer text this feature persists -- would outlive the lifetime
-- the plan section 6 budget promises.
--
-- Deliberately global rather than per-task, and deliberately its own function.
-- Two callers, on purpose. `activate_agent_clarification` calls it so opening
-- an exchange pays for the last one, and the backend calls it directly on a
-- timer from startup, which is what actually makes the documented retention a
-- promise: an abandoned pair leaves nobody to open anything, and on a quiet
-- deployment nothing opens at all. `agent_clarification_payloads_expiry` is the
-- index that makes it cheap enough to run on that timer.
create or replace function public.sweep_expired_agent_clarification_payloads()
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.agent_clarification_payloads
   where expires_at <= now();
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.sweep_expired_agent_clarification_payloads()
from public, anon, authenticated;
grant execute on function public.sweep_expired_agent_clarification_payloads() to service_role;

-- A participant-safe projection. It contains only the short-lived text that
-- already crossed under the bilateral task grant and safe structural state.
create or replace function public.agent_clarification_task_json(p_task_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'taskId', t.task_id,
    'originSharedMessageId', c.origin_shared_message_id,
    'conversationId', c.conversation_id,
    'githubRepositoryId', c.github_repository_id::text,
    'requesterUserId', c.requester_user_id,
    'responderUserId', c.responder_user_id,
    'requesterProvider', t.requester_provider,
    'requesterModel', t.requester_model,
    'responderProvider', t.responder_provider,
    'responderModel', t.responder_model,
    'state', t.state,
    'questionsUsed', t.questions_used,
    'followUpRounds', c.follow_up_rounds,
    'version', t.version,
    'expectedUserId', t.expected_user_id,
    'expectedLane', t.expected_lane,
    'currentStepId', t.current_step_id,
    'expiresAt', public.iso_utc(c.expires_at),
    'steps', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'stepId', s.step_id,
          'parentStepId', s.parent_step_id,
          'sequence', s.sequence,
          'askedByUserId', s.asked_by_user_id,
          'askedToUserId', s.asked_to_user_id,
          'question', p.question,
          'answer', p.answer,
          'status', s.status,
          'reasonCode', s.reason_code,
          'sharedBasisMessageIds', to_jsonb(s.shared_basis_message_ids),
          'contentHash', s.content_hash,
          'answerHash', s.answer_hash,
          'humanRequiredReason', s.human_required_reason,
          'createdAt', public.iso_utc(s.created_at),
          'resolvedAt', case when s.resolved_at is null then null
            else public.iso_utc(s.resolved_at) end
        ) order by s.sequence
      )
      from public.agent_clarification_steps s
      left join public.agent_clarification_payloads p on p.step_id = s.step_id
      where s.task_id = t.task_id
    ), '[]'::jsonb)
  )
  from public.agent_clarification_tasks t
  join public.collaboration_tasks c on c.task_id = t.task_id
  where t.task_id = p_task_id;
$$;

revoke all on function public.agent_clarification_task_json(uuid)
from public, anon, authenticated;
grant execute on function public.agent_clarification_task_json(uuid) to service_role;

-- Approved shared context only, bounded at the originating message. Later
-- conversation messages belong to later tasks and cannot silently widen this
-- task's dialogue grant.
create or replace function public.load_agent_clarification_context(
  p_task_id uuid,
  p_actor_user_id uuid,
  p_message_limit integer
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with selected as (
    select c.*, s.state, origin.sent_at as origin_sent_at
    from public.collaboration_tasks c
    join public.agent_clarification_tasks s on s.task_id = c.task_id
    join public.shared_messages origin
      on origin.message_id = c.origin_shared_message_id
    join public.agent_dialogue_origin_grants grant_row
      on grant_row.origin_shared_message_id = c.origin_shared_message_id
     and grant_row.grantor_user_id = c.requester_user_id
     and grant_row.revoked_at is null
     -- Re-checked on every read, not trusted from activation time. An exchange
     -- that outlives its consent stops being able to see the shared history
     -- that consent was about, which is the only thing this function hands out.
     and grant_row.expires_at > now()
    where c.task_id = p_task_id
      and p_actor_user_id in (c.requester_user_id, c.responder_user_id)
      and c.status = 'active'
      and c.expires_at > now()
      and s.state not in ('completed', 'cancelled', 'expired')
  ), bounded_messages as (
    select m.*, identity.github_login
    from public.shared_messages m
    join selected s on s.conversation_id = m.conversation_id
    join public.account_github_identities identity
      on identity.user_id = m.sender_user_id
    where m.github_repository_id = s.github_repository_id
      and (m.sent_at, m.message_id)
          <= (s.origin_sent_at, s.origin_shared_message_id)
    order by m.sent_at desc, m.message_id desc
    limit case when p_message_limit between 1 and 200 then p_message_limit else 0 end
  )
  select jsonb_build_object(
    'taskId', s.task_id,
    'requesterName', requester.github_login,
    'responderName', responder.github_login,
    'sharedHistory', coalesce((
      select jsonb_agg(jsonb_build_object(
        'messageId', m.message_id,
        'authorUserId', m.sender_user_id,
        'authorName', m.github_login,
        'text', m.body,
        'sentAt', public.iso_utc(m.sent_at)
      ) order by m.sent_at, m.message_id)
      from bounded_messages m
    ), '[]'::jsonb)
  )
  from selected s
  join public.account_github_identities requester
    on requester.user_id = s.requester_user_id
  join public.account_github_identities responder
    on responder.user_id = s.responder_user_id;
$$;

revoke all on function public.load_agent_clarification_context(uuid, uuid, integer)
from public, anon, authenticated;
grant execute on function public.load_agent_clarification_context(uuid, uuid, integer)
to service_role;

create or replace function public.grant_agent_dialogue_originator(
  p_origin_shared_message_id uuid,
  p_actor_user_id uuid,
  p_provider text,
  p_model text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_message public.shared_messages;
  v_existing public.agent_dialogue_origin_grants;
  v_now timestamptz := now();
  v_expires timestamptz;
begin
  -- Every argument gate in this file spells out `is null` before testing the
  -- value, and the reason is worth stating once here. These gates are written
  -- as "if the argument is bad, refuse", but SQL's `not in` and
  -- `octet_length(...) not between` both return NULL rather than true when the
  -- argument is NULL, and `if NULL then` takes the else branch. A gate that
  -- reads as a rejection therefore *accepts* a NULL -- fail-open, in the one
  -- place that exists to fail closed. Downstream that is either a not-null
  -- constraint raising an unhandled exception where a clean 'unavailable' was
  -- owed, or worse: a null `p_outcome` falls past both branch tests and lands
  -- in the answered path, resolving a step nobody answered.
  if p_provider is null or p_provider not in ('codex', 'claude')
     or (p_model is not null and p_model !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  select * into v_message from public.shared_messages
   where message_id = p_origin_shared_message_id;
  if not found or v_message.sender_user_id <> p_actor_user_id then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  -- 60 minutes, the same lifetime a collaboration task gets, because that is
  -- the longest the exchange this consent authorizes is allowed to live. A
  -- grant outliving it would authorize nothing while still reading as live.
  v_expires := v_now + interval '60 minutes';
  insert into public.agent_dialogue_origin_grants (
    origin_shared_message_id, grantor_user_id, provider, model, granted_at,
    expires_at, revoked_at
  ) values (
    p_origin_shared_message_id, p_actor_user_id, p_provider, p_model, v_now,
    v_expires, null
  ) on conflict (origin_shared_message_id) do nothing;
  select * into v_existing from public.agent_dialogue_origin_grants
   where origin_shared_message_id = p_origin_shared_message_id;
  if v_existing.grantor_user_id <> p_actor_user_id or v_existing.revoked_at is not null then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  -- Re-arm rather than leave the first stamp standing. Consenting again is the
  -- same person saying the same thing now, and 'greatest' keeps the clock
  -- moving one way so a retry with a trailing clock cannot shorten it.
  if v_existing.expires_at < v_expires then
    update public.agent_dialogue_origin_grants
       set expires_at = greatest(v_expires, expires_at)
     where origin_shared_message_id = p_origin_shared_message_id;
  end if;
  return jsonb_build_object('outcome', 'granted');
end;
$$;

create or replace function public.activate_agent_clarification(
  p_task_id uuid,
  p_responder_user_id uuid,
  p_provider text,
  p_model text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_task public.collaboration_tasks;
  v_grant public.agent_dialogue_origin_grants;
  v_existing public.agent_clarification_tasks;
  v_now timestamptz := now();
begin
  if p_provider is null or p_provider not in ('codex', 'claude')
     or (p_model is not null and p_model !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  -- Opening a new exchange is the one moment this feature is guaranteed to be
  -- in use, so it pays for the retention of the exchanges nobody closed.
  perform public.sweep_expired_agent_clarification_payloads();
  select * into v_task from public.collaboration_tasks
   where task_id = p_task_id for update;
  if not found or v_task.responder_user_id <> p_responder_user_id
     or v_task.status <> 'active' or v_task.expires_at <= v_now then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  select * into v_grant from public.agent_dialogue_origin_grants
   where origin_shared_message_id = v_task.origin_shared_message_id
     and grantor_user_id = v_task.requester_user_id
     and revoked_at is null;
  if not found then
    return jsonb_build_object('outcome', 'consent_missing');
  end if;
  -- Distinct from 'consent_missing' on purpose. "Never agreed" and "agreed an
  -- hour ago" want different things said to the recipient and different things
  -- done by an operator reading logs; collapsing them hides the expiry working.
  if v_grant.expires_at <= v_now then
    return jsonb_build_object('outcome', 'consent_expired');
  end if;
  select * into v_existing from public.agent_clarification_tasks
   where task_id = p_task_id;
  if found then
    if v_existing.state in ('completed', 'cancelled', 'expired') then
      return jsonb_build_object('outcome', 'unavailable');
    end if;
    return jsonb_build_object(
      'outcome', 'active',
      'task', public.agent_clarification_task_json(p_task_id)
    );
  end if;
  insert into public.agent_clarification_tasks (
    task_id, requester_provider, requester_model, responder_provider,
    responder_model, state, questions_used, version, expected_user_id,
    expected_lane, current_step_id, created_at, updated_at
  ) values (
    p_task_id, v_grant.provider, v_grant.model, p_provider, p_model,
    'recipient_running', 0, 0, p_responder_user_id, 'private_work', null,
    v_now, v_now
  );
  return jsonb_build_object(
    'outcome', 'active',
    'task', public.agent_clarification_task_json(p_task_id)
  );
end;
$$;

create or replace function public.load_agent_clarification(
  p_task_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_task public.collaboration_tasks;
  v_state public.agent_clarification_tasks;
  v_now timestamptz := now();
begin
  select * into v_task from public.collaboration_tasks where task_id = p_task_id;
  select * into v_state from public.agent_clarification_tasks where task_id = p_task_id;
  if not found or (v_task.requester_user_id <> p_actor_user_id
      and v_task.responder_user_id <> p_actor_user_id) then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  if v_task.expires_at <= v_now and v_state.state not in ('completed', 'cancelled', 'expired') then
    update public.agent_clarification_tasks set
      state = 'expired', expected_user_id = null, expected_lane = null,
      current_step_id = null, version = version + 1, updated_at = v_now
    where task_id = p_task_id;
    delete from public.agent_clarification_payloads where task_id = p_task_id;
  end if;
  return jsonb_build_object(
    'outcome', 'available',
    'task', public.agent_clarification_task_json(p_task_id)
  );
end;
$$;

create or replace function public.begin_agent_clarification_question(
  p_task_id uuid,
  p_actor_user_id uuid,
  p_step_id uuid,
  p_question text,
  p_reason_code text,
  p_shared_basis_message_ids uuid[],
  p_content_hash text,
  p_expected_version integer
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_task public.collaboration_tasks;
  v_state public.agent_clarification_tasks;
  v_now timestamptz := now();
begin
  if p_question is null or octet_length(p_question) not between 1 and 500
     or p_reason_code is null
     or p_reason_code not in ('ambiguity', 'contradiction', 'missing_intent')
     or coalesce(cardinality(p_shared_basis_message_ids), 0) > 8
     or p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  select * into v_task from public.collaboration_tasks
   where task_id = p_task_id for update;
  select * into v_state from public.agent_clarification_tasks
   where task_id = p_task_id for update;
  if not found or v_task.status <> 'active' or v_task.expires_at <= v_now
     or v_task.responder_user_id <> p_actor_user_id
     or v_state.state <> 'recipient_running'
     or v_state.expected_user_id <> p_actor_user_id
     or v_state.expected_lane <> 'private_work' then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  if v_state.version <> p_expected_version then
    return jsonb_build_object('outcome', 'stale');
  end if;
  if v_state.questions_used >= 2 or v_task.follow_up_rounds >= 5 then
    return jsonb_build_object('outcome', 'exhausted');
  end if;
  if exists (select 1 from public.agent_clarification_steps
      where task_id = p_task_id and (content_hash = p_content_hash or answer_hash = p_content_hash)) then
    return jsonb_build_object('outcome', 'stale');
  end if;
  update public.collaboration_tasks set follow_up_rounds = follow_up_rounds + 1
   where task_id = p_task_id;
  insert into public.agent_clarification_steps (
    step_id, task_id, parent_step_id, sequence, asked_by_user_id,
    asked_to_user_id, status, reason_code, shared_basis_message_ids,
    content_hash, answer_hash, human_required_reason, created_at, resolved_at
  ) values (
    p_step_id, p_task_id, null, v_state.questions_used + 1,
    v_task.responder_user_id, v_task.requester_user_id, 'pending',
    p_reason_code, coalesce(p_shared_basis_message_ids, '{}'::uuid[]),
    p_content_hash, null, null, v_now, null
  );
  insert into public.agent_clarification_payloads (
    step_id, task_id, question, answer, expires_at
  ) values (p_step_id, p_task_id, p_question, null, v_task.expires_at);
  update public.agent_clarification_tasks set
    state = 'dialogue_running', questions_used = questions_used + 1,
    expected_user_id = v_task.requester_user_id,
    expected_lane = 'clarification_dialogue', current_step_id = p_step_id,
    version = version + 1, updated_at = v_now
  where task_id = p_task_id;
  return jsonb_build_object(
    'outcome', 'route_dialogue',
    'task', public.agent_clarification_task_json(p_task_id)
  );
end;
$$;

create or replace function public.list_agent_clarifications(
  p_actor_user_id uuid,
  p_github_repository_id bigint,
  p_conversation_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    public.agent_clarification_task_json(c.task_id)
    order by c.created_at desc
  ), '[]'::jsonb)
  from (
    select task_id, created_at
    from public.collaboration_tasks
    where conversation_id = p_conversation_id
      and github_repository_id = p_github_repository_id
      and p_actor_user_id in (requester_user_id, responder_user_id)
    order by created_at desc
    limit 50
  ) c
  join public.agent_clarification_tasks state on state.task_id = c.task_id;
$$;

create or replace function public.record_agent_clarification_dialogue_result(
  p_task_id uuid,
  p_actor_user_id uuid,
  p_current_step_id uuid,
  p_counter_step_id uuid,
  p_expected_version integer,
  p_outcome text,
  p_answer text,
  p_question text,
  p_reason_code text,
  p_shared_basis_message_ids uuid[],
  p_human_required_reason text,
  p_content_hash text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_task public.collaboration_tasks;
  v_state public.agent_clarification_tasks;
  v_step public.agent_clarification_steps;
  v_parent public.agent_clarification_steps;
  v_other uuid;
  v_now timestamptz := now();
begin
  -- A null outcome matches neither branch test below and would fall through to
  -- the answered path, resolving a step with no answer. See the note on
  -- `grant_agent_dialogue_originator`.
  if p_outcome is null
     or p_outcome not in ('answered', 'counter_question', 'human_required') then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  select * into v_task from public.collaboration_tasks
   where task_id = p_task_id for update;
  select * into v_state from public.agent_clarification_tasks
   where task_id = p_task_id for update;
  select * into v_step from public.agent_clarification_steps
   where step_id = p_current_step_id and task_id = p_task_id for update;
  if not found or v_task.status <> 'active' or v_task.expires_at <= v_now
     or v_state.state <> 'dialogue_running'
     or v_state.expected_user_id <> p_actor_user_id
     or v_state.expected_lane <> 'clarification_dialogue'
     or v_state.current_step_id <> p_current_step_id
     or v_step.asked_to_user_id <> p_actor_user_id
     or v_step.status <> 'pending' then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  if v_state.version <> p_expected_version then
    return jsonb_build_object('outcome', 'stale');
  end if;

  if p_outcome = 'human_required' then
    if p_answer is not null or p_question is not null
       or p_human_required_reason is null
       or p_human_required_reason not in ('new_authority', 'private_context', 'ambiguous', 'safety') then
      return jsonb_build_object('outcome', 'unavailable');
    end if;
    update public.agent_clarification_steps set
      status = 'human_required', human_required_reason = p_human_required_reason
    where step_id = p_current_step_id;
    update public.agent_clarification_tasks set
      state = 'human_required', expected_lane = 'human',
      version = version + 1, updated_at = v_now
    where task_id = p_task_id;
    return jsonb_build_object(
      'outcome', 'human_required',
      'task', public.agent_clarification_task_json(p_task_id)
    );
  end if;

  if p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('outcome', 'unavailable');
  end if;

  if p_outcome = 'counter_question' then
    if p_answer is not null
       or p_question is null
       or octet_length(p_question) not between 1 and 500
       or p_reason_code is null
       or p_reason_code not in ('ambiguity', 'contradiction', 'missing_intent')
       or coalesce(cardinality(p_shared_basis_message_ids), 0) > 8 then
      return jsonb_build_object('outcome', 'unavailable');
    end if;
    if v_state.questions_used >= 2 or v_task.follow_up_rounds >= 5 then
      return jsonb_build_object('outcome', 'exhausted');
    end if;
    if exists (select 1 from public.agent_clarification_steps
        where task_id = p_task_id and (content_hash = p_content_hash or answer_hash = p_content_hash)) then
      return jsonb_build_object('outcome', 'stale');
    end if;
    v_other := case when p_actor_user_id = v_task.requester_user_id
      then v_task.responder_user_id else v_task.requester_user_id end;
    update public.collaboration_tasks set follow_up_rounds = follow_up_rounds + 1
     where task_id = p_task_id;
    insert into public.agent_clarification_steps (
      step_id, task_id, parent_step_id, sequence, asked_by_user_id,
      asked_to_user_id, status, reason_code, shared_basis_message_ids,
      content_hash, answer_hash, human_required_reason, created_at, resolved_at
    ) values (
      p_counter_step_id, p_task_id, p_current_step_id,
      v_state.questions_used + 1, p_actor_user_id, v_other,
      'pending', p_reason_code,
      coalesce(p_shared_basis_message_ids, '{}'::uuid[]),
      p_content_hash, null, null, v_now, null
    );
    insert into public.agent_clarification_payloads (
      step_id, task_id, question, answer, expires_at
    ) values (p_counter_step_id, p_task_id, p_question, null, v_task.expires_at);
    update public.agent_clarification_tasks set
      questions_used = questions_used + 1,
      expected_user_id = v_other, expected_lane = 'clarification_dialogue',
      current_step_id = p_counter_step_id, version = version + 1,
      updated_at = v_now
    where task_id = p_task_id;
    return jsonb_build_object(
      'outcome', 'route_dialogue',
      'task', public.agent_clarification_task_json(p_task_id)
    );
  end if;

  if p_question is not null or p_human_required_reason is not null
     or p_reason_code is not null
     or coalesce(cardinality(p_shared_basis_message_ids), 0) > 8
     or p_answer is null
     or octet_length(p_answer) not between 1 and 1500 then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  -- Plan section 6: an exact normalized repeat is deterministic no progress, and
  -- the answered branch needs the check as much as the counter-question branch.
  -- An answer whose bytes the task has already seen -- the same answer twice, or
  -- the question echoed back as its own answer -- means the two agents are
  -- circling, and no further round will break it.
  --
  -- This escalates rather than returning 'stale'. A stale result invites the
  -- caller to reload and try again, which is the one thing that cannot help
  -- here; the plan asks to stop at the first detected repetition instead of
  -- spending the remaining rounds. The two humans get the question back, which
  -- is where it was always going to end up.
  if exists (select 1 from public.agent_clarification_steps
      where task_id = p_task_id and (content_hash = p_content_hash or answer_hash = p_content_hash)) then
    update public.agent_clarification_steps set
      status = 'human_required', human_required_reason = 'ambiguous'
    where step_id = p_current_step_id;
    update public.agent_clarification_tasks set
      state = 'human_required', expected_lane = 'human',
      version = version + 1, updated_at = v_now
    where task_id = p_task_id;
    return jsonb_build_object(
      'outcome', 'human_required',
      'task', public.agent_clarification_task_json(p_task_id)
    );
  end if;
  if v_task.follow_up_rounds >= 5 then
    return jsonb_build_object('outcome', 'exhausted');
  end if;
  update public.agent_clarification_steps set
    status = 'resolved', answer_hash = p_content_hash,
    human_required_reason = null, resolved_at = v_now
  where step_id = p_current_step_id;
  update public.agent_clarification_payloads set answer = p_answer
  where step_id = p_current_step_id;
  select * into v_parent from public.agent_clarification_steps
   where step_id = v_step.parent_step_id and task_id = p_task_id and status = 'pending';
  update public.collaboration_tasks set follow_up_rounds = follow_up_rounds + 1
   where task_id = p_task_id;
  -- Deliberately not `found`. PL/pgSQL resets FOUND on the UPDATE above, which
  -- always matches its row, so FOUND here is unconditionally true no matter
  -- what the parent lookup returned. Every answer would then route to a parent
  -- step that usually does not exist, leaving the task dialogue_running with a
  -- null expected actor -- a state no caller can ever match, and which nothing
  -- but expiry can clear. Ask the row we actually selected.
  if v_parent.step_id is not null then
    update public.agent_clarification_tasks set
      state = 'dialogue_running', expected_user_id = v_parent.asked_to_user_id,
      expected_lane = 'clarification_dialogue', current_step_id = v_parent.step_id,
      version = version + 1, updated_at = v_now
    where task_id = p_task_id;
    return jsonb_build_object(
      'outcome', 'route_dialogue',
      'task', public.agent_clarification_task_json(p_task_id)
    );
  end if;
  update public.agent_clarification_tasks set
    state = 'recipient_running', expected_user_id = v_task.responder_user_id,
    expected_lane = 'private_work', current_step_id = null,
    version = version + 1, updated_at = v_now
  where task_id = p_task_id;
  return jsonb_build_object(
    'outcome', 'resume_recipient',
    'task', public.agent_clarification_task_json(p_task_id)
  );
end;
$$;

create or replace function public.continue_agent_clarification(
  p_task_id uuid,
  p_actor_user_id uuid,
  p_current_step_id uuid,
  p_answer text,
  p_answer_hash text,
  p_expected_version integer
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_task public.collaboration_tasks;
  v_state public.agent_clarification_tasks;
  v_step public.agent_clarification_steps;
  v_parent public.agent_clarification_steps;
  v_now timestamptz := now();
begin
  if p_answer is null or octet_length(p_answer) not between 1 and 1500
     or p_answer_hash is null or p_answer_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  select * into v_task from public.collaboration_tasks
   where task_id = p_task_id for update;
  select * into v_state from public.agent_clarification_tasks
   where task_id = p_task_id for update;
  select * into v_step from public.agent_clarification_steps
   where step_id = p_current_step_id and task_id = p_task_id for update;
  if not found or v_task.status <> 'active' or v_task.expires_at <= v_now
     or v_state.state <> 'human_required' or v_state.expected_lane <> 'human'
     or v_state.expected_user_id <> p_actor_user_id
     or v_state.current_step_id <> p_current_step_id
     or v_step.status <> 'human_required' or v_step.asked_to_user_id <> p_actor_user_id then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  if v_state.version <> p_expected_version then
    return jsonb_build_object('outcome', 'stale');
  end if;
  if v_task.follow_up_rounds >= 5 then
    return jsonb_build_object('outcome', 'exhausted');
  end if;
  update public.agent_clarification_steps set
    status = 'resolved', answer_hash = p_answer_hash,
    human_required_reason = null, resolved_at = v_now
  where step_id = p_current_step_id;
  update public.agent_clarification_payloads set answer = p_answer
  where step_id = p_current_step_id;
  select * into v_parent from public.agent_clarification_steps
   where step_id = v_step.parent_step_id and task_id = p_task_id and status = 'pending';
  update public.collaboration_tasks set follow_up_rounds = follow_up_rounds + 1
   where task_id = p_task_id;
  -- Not `found`; see the note in record_agent_clarification_dialogue_result.
  if v_parent.step_id is not null then
    update public.agent_clarification_tasks set
      state = 'dialogue_running', expected_user_id = v_parent.asked_to_user_id,
      expected_lane = 'clarification_dialogue', current_step_id = v_parent.step_id,
      version = version + 1, updated_at = v_now
    where task_id = p_task_id;
    return jsonb_build_object(
      'outcome', 'route_dialogue',
      'task', public.agent_clarification_task_json(p_task_id)
    );
  end if;
  update public.agent_clarification_tasks set
    state = 'recipient_running', expected_user_id = v_task.responder_user_id,
    expected_lane = 'private_work', current_step_id = null,
    version = version + 1, updated_at = v_now
  where task_id = p_task_id;
  return jsonb_build_object(
    'outcome', 'resume_recipient',
    'task', public.agent_clarification_task_json(p_task_id)
  );
end;
$$;

create or replace function public.stop_agent_clarification(
  p_task_id uuid,
  p_actor_user_id uuid,
  p_completed boolean
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_task public.collaboration_tasks;
  v_state public.agent_clarification_tasks;
  v_now timestamptz := now();
  v_terminal text := case when p_completed then 'completed' else 'cancelled' end;
begin
  select * into v_task from public.collaboration_tasks
   where task_id = p_task_id for update;
  select * into v_state from public.agent_clarification_tasks
   where task_id = p_task_id for update;
  if not found or (v_task.requester_user_id <> p_actor_user_id
      and v_task.responder_user_id <> p_actor_user_id) then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  if v_state.state in ('completed', 'cancelled', 'expired') then
    delete from public.agent_clarification_payloads where task_id = p_task_id;
    return jsonb_build_object('outcome', 'already_terminal');
  end if;
  update public.agent_clarification_tasks set
    state = v_terminal, expected_user_id = null, expected_lane = null,
    current_step_id = null, version = version + 1, updated_at = v_now
  where task_id = p_task_id;
  update public.agent_dialogue_origin_grants set revoked_at = v_now
   where origin_shared_message_id = v_task.origin_shared_message_id
     and revoked_at is null;
  delete from public.agent_clarification_payloads where task_id = p_task_id;
  return jsonb_build_object('outcome', 'stopped');
end;
$$;

-- Taking the originator's consent back, before or after anything uses it.
--
-- 'stop_agent_clarification' revokes too, and it is not enough on its own: it
-- needs a clarification task to stop, and the window this covers is the one
-- before any task exists. Consent is written by `Send`, and the recipient's
-- agent may pick it up minutes or an hour later; between those two moments the
-- originator could see the grant and had no way to withdraw it.
--
-- Cancels whatever the grant is already feeding, so that revoking is a single
-- act rather than two the caller has to remember to sequence. The same three
-- guarantees a stop gives -- no live consent, no unread text, and a structural
-- audit trail that survives both -- because a half-revoked exchange whose
-- context loads keep failing is a worse state than a cancelled one.
create or replace function public.revoke_agent_dialogue_originator(
  p_origin_shared_message_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_grant public.agent_dialogue_origin_grants;
  v_now timestamptz := now();
  v_task_ids uuid[];
begin
  select * into v_grant from public.agent_dialogue_origin_grants
   where origin_shared_message_id = p_origin_shared_message_id
   for update;
  -- Grantor only. Not the recipient: the recipient already ends an exchange
  -- with 'stop_agent_clarification', and letting them clear the originator's
  -- consent record would let one person edit the other's authorization.
  if not found or p_actor_user_id is null
     or v_grant.grantor_user_id <> p_actor_user_id then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  if v_grant.revoked_at is not null then
    -- Idempotent. A second revoke is a person clicking twice, not an error.
    return jsonb_build_object('outcome', 'revoked', 'cancelledTaskIds', '[]'::jsonb);
  end if;

  update public.agent_dialogue_origin_grants
     set revoked_at = greatest(v_now, granted_at)
   where origin_shared_message_id = p_origin_shared_message_id;

  select coalesce(array_agg(s.task_id), '{}'::uuid[]) into v_task_ids
    from public.agent_clarification_tasks s
    join public.collaboration_tasks c on c.task_id = s.task_id
   where c.origin_shared_message_id = p_origin_shared_message_id
     and s.state not in ('completed', 'cancelled', 'expired');

  if cardinality(v_task_ids) > 0 then
    update public.agent_clarification_tasks set
      state = 'cancelled', expected_user_id = null, expected_lane = null,
      current_step_id = null, version = version + 1, updated_at = v_now
    where task_id = any(v_task_ids);
    delete from public.agent_clarification_payloads
     where task_id = any(v_task_ids);
  end if;

  -- The ids, not a count. A cancelled exchange may have a loop parked on it in
  -- the calling process, and the caller can only wake what it can name.
  return jsonb_build_object(
    'outcome', 'revoked',
    'cancelledTaskIds', to_jsonb(v_task_ids)
  );
end;
$$;

-- Recovering exchanges that a restart left mid-flight.
--
-- Task rows are durable and the loop that advances them is not. The
-- coordinator holds an active exchange in process memory between rounds, and a
-- person's answer reaches it by waking that in-memory wait, so a backend
-- restart loses every driver while every 'dialogue_running' and
-- 'human_required' row survives.
--
-- Such an exchange is unreachable. Nothing will dispatch its next dialogue
-- turn, and an answer to a parked 'human_required' step transitions the row and
-- then reaches no one, because the loop that would have consumed it is gone.
-- Without this the owner is shown a question to answer for as long as the task
-- lives, and answering it does nothing.
--
-- Cancelling is the honest end and not a resume: this runs beside
-- 'reconcile_running_private_drafts', which has already failed the private
-- draft the exchange hangs off, so there is nothing left to resume into. The
-- origin grant is revoked and the question/answer text deleted, exactly as
-- 'stop_agent_clarification' does, because a cancelled exchange must not leave
-- live consent or unread text behind it.
--
-- SINGLE WRITER. This cancels every non-terminal exchange, not only the ones
-- this process was driving, because a restarted process cannot tell them apart
-- -- the in-memory waits it would need died with the previous process. Correct
-- for the single control-plane container this deployment runs, and WRONG the
-- moment a second replica starts, where it would cancel exchanges another live
-- instance is mid-round on. The fix is the same one
-- 'reconcile_running_private_drafts' names: an owning-instance column, scoped
-- to the instance that is starting.
--
-- UNCONDITIONAL. No age floor, so a crash-looping process cancels exchanges
-- seconds old. Acceptable while a restart genuinely means every driver is gone.
create or replace function public.reconcile_running_agent_clarifications(
  p_updated_at timestamptz
)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_task_ids uuid[];
begin
  -- Deliberately unlocked. This runs before the process serves its first
  -- request, so there is no concurrent writer to lose a race against; taking
  -- row locks here would only be theatre, and 'for update' cannot be combined
  -- with the aggregate anyway.
  select coalesce(array_agg(task_id), '{}'::uuid[]) into v_task_ids
    from public.agent_clarification_tasks
   where state not in ('completed', 'cancelled', 'expired');

  if cardinality(v_task_ids) = 0 then
    return 0;
  end if;

  update public.agent_clarification_tasks set
    state = 'cancelled', expected_user_id = null, expected_lane = null,
    current_step_id = null, version = version + 1, updated_at = p_updated_at
  where task_id = any(v_task_ids);

  -- 'greatest' rather than the argument alone: a caller whose clock trails the
  -- database would otherwise trip the grant's own time-order check and take
  -- startup down, which is a worse failure than a revocation stamped late.
  update public.agent_dialogue_origin_grants as g
     set revoked_at = greatest(p_updated_at, g.granted_at)
    from public.collaboration_tasks as c
   where c.task_id = any(v_task_ids)
     and g.origin_shared_message_id = c.origin_shared_message_id
     and g.revoked_at is null;

  delete from public.agent_clarification_payloads
   where task_id = any(v_task_ids);

  return cardinality(v_task_ids);
end;
$$;

-- Browser roles cannot call service orchestration directly. Every function is
-- reached through an authenticated server route which derives the actor.
revoke all on function public.grant_agent_dialogue_originator(uuid, uuid, text, text)
from public, anon, authenticated;
revoke all on function public.revoke_agent_dialogue_originator(uuid, uuid)
from public, anon, authenticated;
revoke all on function public.activate_agent_clarification(uuid, uuid, text, text)
from public, anon, authenticated;
revoke all on function public.load_agent_clarification(uuid, uuid)
from public, anon, authenticated;
revoke all on function public.list_agent_clarifications(uuid, bigint, uuid)
from public, anon, authenticated;
revoke all on function public.begin_agent_clarification_question(uuid, uuid, uuid, text, text, uuid[], text, integer)
from public, anon, authenticated;
revoke all on function public.record_agent_clarification_dialogue_result(uuid, uuid, uuid, uuid, integer, text, text, text, text, uuid[], text, text)
from public, anon, authenticated;
revoke all on function public.continue_agent_clarification(uuid, uuid, uuid, text, text, integer)
from public, anon, authenticated;
revoke all on function public.stop_agent_clarification(uuid, uuid, boolean)
from public, anon, authenticated;
revoke all on function public.reconcile_running_agent_clarifications(timestamptz)
from public, anon, authenticated;

grant execute on function public.grant_agent_dialogue_originator(uuid, uuid, text, text) to service_role;
grant execute on function public.revoke_agent_dialogue_originator(uuid, uuid) to service_role;
grant execute on function public.activate_agent_clarification(uuid, uuid, text, text) to service_role;
grant execute on function public.load_agent_clarification(uuid, uuid) to service_role;
grant execute on function public.list_agent_clarifications(uuid, bigint, uuid) to service_role;
grant execute on function public.begin_agent_clarification_question(uuid, uuid, uuid, text, text, uuid[], text, integer) to service_role;
grant execute on function public.record_agent_clarification_dialogue_result(uuid, uuid, uuid, uuid, integer, text, text, text, text, uuid[], text, text) to service_role;
grant execute on function public.continue_agent_clarification(uuid, uuid, uuid, text, text, integer) to service_role;
grant execute on function public.stop_agent_clarification(uuid, uuid, boolean) to service_role;
grant execute on function public.reconcile_running_agent_clarifications(timestamptz) to service_role;
