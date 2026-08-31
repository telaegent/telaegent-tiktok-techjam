-- Opening and closing the bounded collaboration a capability loop runs inside.
--
-- Until now a task could be read, granted against and counted, but nothing
-- could create one. This is the seam between the shared conversation and the
-- capability loop: a message that crossed the human gate opens exactly one
-- task, and every grant and every follow-up round afterwards is bounded by it.
--
-- Scope is derived here, never accepted from a caller. The conversation, the
-- project and the repository all come from the shared message itself, so a
-- server bug cannot open a task that points at a repository the message did
-- not belong to.

-- ---------------------------------------------------------------------------
-- 1. Open a task for one shared message
-- ---------------------------------------------------------------------------
-- Idempotent by construction: `origin_shared_message_id` is unique, so a retried
-- send lands on the same task rather than opening a second one with a fresh
-- round budget.
--
-- One crossing message is one collaboration. A later message opens its own
-- task, with its own five rounds and its own grants, so authority a human
-- delegated for one exchange never silently carries into the next.
create or replace function public.open_collaboration_task(
  p_task_id                  uuid,
  p_origin_shared_message_id uuid,
  p_responder_user_id        uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_message      public.shared_messages;
  v_conversation public.project_conversations;
  v_project      public.repository_projects;
  v_existing     public.collaboration_tasks;
  v_now          timestamptz := now();
  v_expires      timestamptz;
begin
  select * into v_message
  from public.shared_messages m
  where m.message_id = p_origin_shared_message_id;
  if not found then
    return jsonb_build_object('outcome', 'unavailable');
  end if;

  -- A task always has two distinct peers: whoever sent the message, and
  -- whoever is being asked to answer it.
  if v_message.sender_user_id = p_responder_user_id then
    return jsonb_build_object('outcome', 'unavailable');
  end if;

  select * into v_conversation
  from public.project_conversations c
  where c.conversation_id = v_message.conversation_id;
  if not found or v_conversation.status <> 'active' then
    return jsonb_build_object('outcome', 'unavailable');
  end if;

  select * into v_project
  from public.repository_projects p
  where p.project_id = v_conversation.project_id;
  if not found
     or v_project.status <> 'active'
     or v_project.github_repository_id <> v_message.github_repository_id then
    return jsonb_build_object('outcome', 'unavailable');
  end if;

  -- Both peers must already be in this conversation. A task can never
  -- introduce a third person to an exchange, or move one into a repository
  -- they were not already talking inside.
  if not exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = v_message.conversation_id
      and cp.user_id = v_message.sender_user_id
  ) or not exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = v_message.conversation_id
      and cp.user_id = p_responder_user_id
  ) then
    return jsonb_build_object('outcome', 'unavailable');
  end if;

  select * into v_existing
  from public.collaboration_tasks t
  where t.origin_shared_message_id = p_origin_shared_message_id;
  if found then
    if v_existing.responder_user_id <> p_responder_user_id then
      return jsonb_build_object('outcome', 'unavailable');
    end if;
    return jsonb_build_object(
      'outcome', 'existing',
      'taskId', v_existing.task_id,
      'conversationId', v_existing.conversation_id,
      'githubRepositoryId', v_existing.github_repository_id::text,
      'expiresAt', to_char(
        v_existing.expires_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    );
  end if;

  -- The outer bound on everything the loop may do. Grants clamp to it, so no
  -- authority delegated inside this task can outlive the task itself.
  v_expires := v_now + interval '60 minutes';

  insert into public.collaboration_tasks (
    task_id, project_id, conversation_id, github_repository_id,
    requester_user_id, responder_user_id, origin_shared_message_id,
    status, created_at, expires_at, ended_at, follow_up_rounds
  ) values (
    p_task_id, v_project.project_id, v_message.conversation_id,
    v_message.github_repository_id, v_message.sender_user_id,
    p_responder_user_id, p_origin_shared_message_id,
    'active', v_now, v_expires, null, 0
  );

  return jsonb_build_object(
    'outcome', 'opened',
    'taskId', p_task_id,
    'conversationId', v_message.conversation_id,
    'githubRepositoryId', v_message.github_repository_id::text,
    'expiresAt', to_char(
      v_expires at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  );
end;
$$;

revoke all on function public.open_collaboration_task(
  uuid, uuid, uuid
) from public, anon, authenticated;

grant execute on function public.open_collaboration_task(
  uuid, uuid, uuid
) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Close a task
-- ---------------------------------------------------------------------------
-- Ending a task is a narrowing act, so either peer may do it. Every grant made
-- inside it stops authorizing anything at the same moment, because
-- `load_capability_route_authorization_snapshot` refuses a task that is not
-- active and `consume_capability_grant` is reached only through it.
create or replace function public.end_collaboration_task(
  p_task_id       uuid,
  p_actor_user_id uuid,
  p_status        text
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
  if p_status not in ('completed', 'cancelled') then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  select * into v_task
  from public.collaboration_tasks t
  where t.task_id = p_task_id
  for update;

  -- One answer for a task that never existed, one that belongs to other
  -- people, and one that is already closed. A caller may not learn which.
  if not found
     or (v_task.requester_user_id <> p_actor_user_id
         and v_task.responder_user_id <> p_actor_user_id) then
    return jsonb_build_object('outcome', 'unavailable');
  end if;

  if v_task.status <> 'active' then
    return jsonb_build_object('outcome', 'already_ended');
  end if;

  update public.collaboration_tasks
     set status = p_status,
         -- Never earlier than the task began, so a backwards clock cannot
         -- violate the row's own time ordering.
         ended_at = greatest(v_now, v_task.created_at)
   where task_id = p_task_id;

  -- Authority does not outlive the collaboration. Active grants are retired in
  -- the same transaction rather than left to expire on their own.
  update public.resource_capability_grants
     set status = 'revoked',
         revoked_at = greatest(v_now, granted_at)
   where task_id = p_task_id
     and status = 'active';

  return jsonb_build_object('outcome', 'ended', 'status', p_status);
end;
$$;

revoke all on function public.end_collaboration_task(
  uuid, uuid, text
) from public, anon, authenticated;

grant execute on function public.end_collaboration_task(
  uuid, uuid, text
) to service_role;
