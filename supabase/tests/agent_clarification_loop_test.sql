-- Transactional contract proof for the task-scoped agent clarification loop.
--
-- Three things are proved here that nothing else in the repository can prove.
--
-- The two-question budget is enforced twice, once by the RPC and once by a
-- column check, and the server's own tests can only reach the first. A live
-- probe cannot reach either: getting a model to volunteer a third question on
-- demand is not something a test can arrange.
--
-- The argument gates fail closed. Every one is written as "if the argument is
-- bad, refuse", and SQL's `not in` and `octet_length(...) not between` return
-- NULL rather than true for a NULL argument, which `if` treats as the else
-- branch -- so the shape that reads as a rejection accepts. Each gate is
-- called here with a null in the position that used to slip through.
--
-- Question and answer text is deleted on every terminal path while the
-- structural audit trail survives. That split is the whole reason the payload
-- table exists, and it is only observable across a full closed loop.
begin;

insert into auth.users (id, aud, role, email, created_at, updated_at) values
  ('a1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'requester@example.test', now(), now()),
  ('a1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
   'responder@example.test', now(), now()),
  ('a1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
   'outsider@example.test', now(), now());

insert into public.user_accounts (user_id, status) values
  ('a1000000-0000-4000-8000-000000000001', 'active'),
  ('a1000000-0000-4000-8000-000000000002', 'active'),
  ('a1000000-0000-4000-8000-000000000003', 'active');

insert into public.account_github_identities
  (user_id, github_user_id, github_login)
values
  ('a1000000-0000-4000-8000-000000000001', 9000001, 'mark'),
  ('a1000000-0000-4000-8000-000000000002', 9000002, 'henry'),
  ('a1000000-0000-4000-8000-000000000003', 9000003, 'outsider');

insert into public.repository_projects
  (project_id, github_repository_id, repository_full_name, visibility,
   default_branch, status)
values
  ('a2000000-0000-4000-8000-000000000001', 1345851099,
   'telaegent/clarification-contract', 'private', 'main', 'active');

insert into public.project_conversations (conversation_id, project_id, status)
values
  ('a3000000-0000-4000-8000-000000000001',
   'a2000000-0000-4000-8000-000000000001', 'active');

-- Ordered deliberately. Task 1 originates at m2, so m1 is inside its context
-- and m3 -- sent later, in the same conversation -- must not be, or a task
-- silently widens its own dialogue grant as the conversation moves on.
insert into public.shared_messages (
  message_id, conversation_id, github_repository_id, sender_user_id,
  body, origin, provider, sent_at
) values
  ('a4000000-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', 1345851099,
   'a1000000-0000-4000-8000-000000000001',
   'Earlier context that precedes the origin message.',
   'agent', 'codex', now() - interval '50 minutes'),
  ('a4000000-0000-4000-8000-000000000002',
   'a3000000-0000-4000-8000-000000000001', 1345851099,
   'a1000000-0000-4000-8000-000000000001',
   'Origin message for the first task.',
   'agent', 'codex', now() - interval '40 minutes'),
  ('a4000000-0000-4000-8000-000000000003',
   'a3000000-0000-4000-8000-000000000001', 1345851099,
   'a1000000-0000-4000-8000-000000000001',
   'LATER MESSAGE OUTSIDE THE FIRST TASK BOUND.',
   'agent', 'codex', now() - interval '30 minutes'),
  ('a4000000-0000-4000-8000-000000000004',
   'a3000000-0000-4000-8000-000000000001', 1345851099,
   'a1000000-0000-4000-8000-000000000001',
   'Origin message for the second task.',
   'agent', 'codex', now() - interval '20 minutes'),
  ('a4000000-0000-4000-8000-000000000005',
   'a3000000-0000-4000-8000-000000000001', 1345851099,
   'a1000000-0000-4000-8000-000000000001',
   'Origin message for the third task.',
   'agent', 'codex', now() - interval '10 minutes'),
  ('a4000000-0000-4000-8000-000000000006',
   'a3000000-0000-4000-8000-000000000001', 1345851099,
   'a1000000-0000-4000-8000-000000000001',
   'Origin message for the fourth task.',
   'agent', 'codex', now() - interval '5 minutes');

insert into public.collaboration_tasks (
  task_id, project_id, conversation_id, github_repository_id,
  requester_user_id, responder_user_id, origin_shared_message_id,
  status, created_at, expires_at, ended_at
) values
  ('a5000000-0000-4000-8000-000000000001',
   'a2000000-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', 1345851099,
   'a1000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000002',
   'a4000000-0000-4000-8000-000000000002',
   'active', now() - interval '40 minutes', now() + interval '1 hour', null),
  ('a5000000-0000-4000-8000-000000000002',
   'a2000000-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', 1345851099,
   'a1000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000002',
   'a4000000-0000-4000-8000-000000000004',
   'active', now() - interval '20 minutes', now() + interval '1 hour', null),
  ('a5000000-0000-4000-8000-000000000003',
   'a2000000-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', 1345851099,
   'a1000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000002',
   'a4000000-0000-4000-8000-000000000005',
   'active', now() - interval '10 minutes', now() + interval '1 hour', null),
  ('a5000000-0000-4000-8000-000000000004',
   'a2000000-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', 1345851099,
   'a1000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000002',
   'a4000000-0000-4000-8000-000000000006',
   'active', now() - interval '5 minutes', now() + interval '1 hour', null);

do $$
declare
  requester uuid := 'a1000000-0000-4000-8000-000000000001';
  responder uuid := 'a1000000-0000-4000-8000-000000000002';
  outsider  uuid := 'a1000000-0000-4000-8000-000000000003';
  origin_1  uuid := 'a4000000-0000-4000-8000-000000000002';
  origin_2  uuid := 'a4000000-0000-4000-8000-000000000004';
  origin_3  uuid := 'a4000000-0000-4000-8000-000000000005';
  origin_4  uuid := 'a4000000-0000-4000-8000-000000000006';
  task_1    uuid := 'a5000000-0000-4000-8000-000000000001';
  task_2    uuid := 'a5000000-0000-4000-8000-000000000002';
  task_3    uuid := 'a5000000-0000-4000-8000-000000000003';
  task_4    uuid := 'a5000000-0000-4000-8000-000000000004';
  step_q1   uuid := 'a6000000-0000-4000-8000-000000000001';
  step_q2   uuid := 'a6000000-0000-4000-8000-000000000002';
  step_q3   uuid := 'a6000000-0000-4000-8000-000000000003';
  step_q4   uuid := 'a6000000-0000-4000-8000-000000000004';
  step_q5   uuid := 'a6000000-0000-4000-8000-000000000005';
  step_q6   uuid := 'a6000000-0000-4000-8000-000000000006';
  step_q7   uuid := 'a6000000-0000-4000-8000-000000000007';
  -- 64 lowercase hex characters, which is all the schema asks of a hash.
  hash_q1 text := repeat('11', 32);
  hash_a1 text := repeat('22', 32);
  hash_q2 text := repeat('33', 32);
  hash_a2 text := repeat('44', 32);
  hash_q3 text := repeat('55', 32);
  hash_q4 text := repeat('66', 32);
  hash_h4 text := repeat('77', 32);
  hash_q5 text := repeat('88', 32);
  hash_q6 text := repeat('99', 32);
  hash_q7 text := repeat('aa', 32);
  hash_a7 text := repeat('bb', 32);
  hash_a6 text := repeat('cc', 32);
  result jsonb;
  task jsonb;
  rounds integer;
  used integer;
  swept integer;
  offenders integer;
  v_role text;
  v_relation text;
  v_privilege text;
  v_signature text;
  signatures text[] := array[
    'public.sweep_expired_agent_clarification_payloads()',
    'public.agent_clarification_task_json(uuid)',
    'public.load_agent_clarification_context(uuid,uuid,integer)',
    'public.grant_agent_dialogue_originator(uuid,uuid,text,text)',
    'public.activate_agent_clarification(uuid,uuid,text,text)',
    'public.load_agent_clarification(uuid,uuid)',
    'public.list_agent_clarifications(uuid,bigint,uuid)',
    'public.begin_agent_clarification_question(uuid,uuid,uuid,text,text,uuid[],text,integer)',
    'public.record_agent_clarification_dialogue_result(uuid,uuid,uuid,uuid,integer,text,text,text,text,uuid[],text,text)',
    'public.continue_agent_clarification(uuid,uuid,uuid,text,text,integer)',
    'public.stop_agent_clarification(uuid,uuid,boolean)'
  ];
  constraint_hit text;
begin
  ---------------------------------------------------------------------------
  -- Consent. The origin grant is the only thing that lets two agents talk.
  ---------------------------------------------------------------------------
  result := public.grant_agent_dialogue_originator(origin_1, responder, 'codex', null);
  if result ->> 'outcome' <> 'unavailable' then
    raise exception 'C1 FAILED: a non-sender granted dialogue on someone elses message';
  end if;

  result := public.grant_agent_dialogue_originator(origin_1, requester, 'gemini', null);
  if result ->> 'outcome' <> 'unavailable' then
    raise exception 'C2 FAILED: an unknown provider was accepted';
  end if;

  result := public.grant_agent_dialogue_originator(origin_1, requester, null, null);
  if result ->> 'outcome' <> 'unavailable' then
    raise exception 'C3 FAILED: a null provider passed the gate';
  end if;

  result := public.activate_agent_clarification(task_1, responder, 'claude', null);
  if result ->> 'outcome' <> 'consent_missing' then
    raise exception 'C4 FAILED: a task activated without an origin grant';
  end if;

  result := public.grant_agent_dialogue_originator(origin_1, requester, 'codex', 'gpt-5-codex');
  if result ->> 'outcome' <> 'granted' then
    raise exception 'C5 FAILED: the sender could not grant dialogue on their own message';
  end if;

  ---------------------------------------------------------------------------
  -- Activation. Only the responder opens the exchange.
  ---------------------------------------------------------------------------
  result := public.activate_agent_clarification(task_1, requester, 'claude', null);
  if result ->> 'outcome' <> 'unavailable' then
    raise exception 'A1 FAILED: the requester activated their own task';
  end if;

  result := public.activate_agent_clarification(task_1, responder, 'claude', 'claude-opus-5');
  task := result -> 'task';
  if result ->> 'outcome' <> 'active'
     or task ->> 'state' <> 'recipient_running'
     or (task ->> 'questionsUsed')::int <> 0
     or (task ->> 'version')::int <> 0
     or task ->> 'expectedUserId' <> responder::text
     or task ->> 'expectedLane' <> 'private_work'
     or task ->> 'currentStepId' is not null
     or task ->> 'requesterProvider' <> 'codex'
     or task ->> 'requesterModel' <> 'gpt-5-codex'
     or task ->> 'responderProvider' <> 'claude' then
    raise exception 'A2 FAILED: activation produced the wrong opening state: %', task;
  end if;

  -- Idempotent: a retried activation returns the live task, never a second one.
  result := public.activate_agent_clarification(task_1, responder, 'claude', 'claude-opus-5');
  if result ->> 'outcome' <> 'active'
     or (result -> 'task' ->> 'version')::int <> 0 then
    raise exception 'A3 FAILED: re-activation was not idempotent';
  end if;

  ---------------------------------------------------------------------------
  -- Context. Bounded at the origin message, and closed to non-participants.
  ---------------------------------------------------------------------------
  result := public.load_agent_clarification_context(task_1, responder, 50);
  if result ->> 'requesterName' <> 'mark' or result ->> 'responderName' <> 'henry' then
    raise exception 'X1 FAILED: context named the wrong participants: %', result;
  end if;
  if jsonb_array_length(result -> 'sharedHistory') <> 2 then
    raise exception 'X2 FAILED: context was not bounded at the origin message: %',
      result -> 'sharedHistory';
  end if;
  if result::text like '%LATER MESSAGE OUTSIDE THE FIRST TASK BOUND%' then
    raise exception 'X3 FAILED: a message sent after the origin leaked into context';
  end if;

  if public.load_agent_clarification_context(task_1, outsider, 50) is not null then
    raise exception 'X4 FAILED: a non-participant read the shared context';
  end if;

  ---------------------------------------------------------------------------
  -- Asking. Wrong actor, wrong version, malformed argument, then the real one.
  ---------------------------------------------------------------------------
  result := public.begin_agent_clarification_question(
    task_1, requester, step_q1, 'Which branch?', 'ambiguity', '{}'::uuid[], hash_q1, 0);
  if result ->> 'outcome' <> 'unavailable' then
    raise exception 'Q1 FAILED: the requester asked during the responders private lane';
  end if;

  result := public.begin_agent_clarification_question(
    task_1, responder, step_q1, 'Which branch?', 'ambiguity', '{}'::uuid[], hash_q1, 99);
  if result ->> 'outcome' <> 'stale' then
    raise exception 'Q2 FAILED: a stale version was accepted';
  end if;

  result := public.begin_agent_clarification_question(
    task_1, responder, step_q1, 'Which branch?', 'curiosity', '{}'::uuid[], hash_q1, 0);
  if result ->> 'outcome' <> 'unavailable' then
    raise exception 'Q3 FAILED: an unknown reason code was accepted';
  end if;

  -- The null gates. Each of these used to fall through the validation block.
  result := public.begin_agent_clarification_question(
    task_1, responder, step_q1, null, 'ambiguity', '{}'::uuid[], hash_q1, 0);
  if result ->> 'outcome' <> 'unavailable' then
    raise exception 'Q4 FAILED: a null question passed the gate';
  end if;

  result := public.begin_agent_clarification_question(
    task_1, responder, step_q1, 'Which branch?', null, '{}'::uuid[], hash_q1, 0);
  if result ->> 'outcome' <> 'unavailable' then
    raise exception 'Q5 FAILED: a null reason code passed the gate';
  end if;

  result := public.begin_agent_clarification_question(
    task_1, responder, step_q1, 'Which branch?', 'ambiguity', '{}'::uuid[], null, 0);
  if result ->> 'outcome' <> 'unavailable' then
    raise exception 'Q6 FAILED: a null content hash passed the gate';
  end if;

  result := public.begin_agent_clarification_question(
    task_1, responder, step_q1, 'Which branch?', 'ambiguity', '{}'::uuid[], 'NOTAHASH', 0);
  if result ->> 'outcome' <> 'unavailable' then
    raise exception 'Q7 FAILED: a malformed content hash was accepted';
  end if;

  -- Nothing above should have consumed budget or moved the task.
  select questions_used, version into used, rounds
    from public.agent_clarification_tasks where task_id = task_1;
  if used <> 0 or rounds <> 0 then
    raise exception 'Q8 FAILED: a rejected question still advanced the task';
  end if;

  result := public.begin_agent_clarification_question(
    task_1, responder, step_q1, 'Which branch should this target?', 'ambiguity',
    array['a4000000-0000-4000-8000-000000000001'::uuid], hash_q1, 0);
  task := result -> 'task';
  if result ->> 'outcome' <> 'route_dialogue'
     or task ->> 'state' <> 'dialogue_running'
     or (task ->> 'questionsUsed')::int <> 1
     or (task ->> 'version')::int <> 1
     or task ->> 'expectedUserId' <> requester::text
     or task ->> 'expectedLane' <> 'clarification_dialogue'
     or task ->> 'currentStepId' <> step_q1::text
     or (task ->> 'followUpRounds')::int <> 1 then
    raise exception 'Q9 FAILED: the first question routed wrongly: %', task;
  end if;

  if not exists (select 1 from public.agent_clarification_payloads
    where step_id = step_q1 and question = 'Which branch should this target?') then
    raise exception 'Q10 FAILED: the question text was not stored in the payload table';
  end if;

  ---------------------------------------------------------------------------
  -- Answering. Only the peer who was asked may answer.
  ---------------------------------------------------------------------------
  result := public.record_agent_clarification_dialogue_result(
    task_1, responder, step_q1, null, 1, 'answered', 'Target main.',
    null, null, null, null, hash_a1);
  if result ->> 'outcome' <> 'unavailable' then
    raise exception 'R1 FAILED: the asker answered their own question';
  end if;

  result := public.record_agent_clarification_dialogue_result(
    task_1, requester, step_q1, null, 1, null, 'Target main.',
    null, null, null, null, hash_a1);
  if result ->> 'outcome' <> 'unavailable' then
    raise exception 'R2 FAILED: a null outcome passed the gate';
  end if;

  result := public.record_agent_clarification_dialogue_result(
    task_1, requester, step_q1, null, 1, 'answered', null,
    null, null, null, null, hash_a1);
  if result ->> 'outcome' <> 'unavailable' then
    raise exception 'R3 FAILED: a null answer resolved the step';
  end if;

  if exists (select 1 from public.agent_clarification_steps
    where step_id = step_q1 and status <> 'pending') then
    raise exception 'R4 FAILED: a rejected result still resolved the step';
  end if;

  result := public.record_agent_clarification_dialogue_result(
    task_1, requester, step_q1, null, 1, 'answered', 'Target main.',
    null, null, null, null, hash_a1);
  task := result -> 'task';
  if result ->> 'outcome' <> 'resume_recipient'
     or task ->> 'state' <> 'recipient_running'
     or (task ->> 'questionsUsed')::int <> 1
     or (task ->> 'version')::int <> 2
     or task ->> 'expectedUserId' <> responder::text
     or task ->> 'expectedLane' <> 'private_work'
     or task ->> 'currentStepId' is not null
     or (task ->> 'followUpRounds')::int <> 2 then
    raise exception 'R5 FAILED: the answer did not hand control back: %', task;
  end if;

  if not exists (select 1 from public.agent_clarification_steps s
    join public.agent_clarification_payloads p on p.step_id = s.step_id
    where s.step_id = step_q1 and s.status = 'resolved'
      and s.answer_hash = hash_a1 and s.resolved_at is not null
      and p.answer = 'Target main.') then
    raise exception 'R6 FAILED: the resolved step was not recorded correctly';
  end if;

  ---------------------------------------------------------------------------
  -- Replay. A hash already used, as question or as answer, cannot come back.
  ---------------------------------------------------------------------------
  result := public.begin_agent_clarification_question(
    task_1, responder, step_q2, 'Same content again?', 'contradiction',
    '{}'::uuid[], hash_q1, 2);
  if result ->> 'outcome' <> 'stale' then
    raise exception 'P1 FAILED: a replayed question hash was accepted';
  end if;

  result := public.begin_agent_clarification_question(
    task_1, responder, step_q2, 'Same content again?', 'contradiction',
    '{}'::uuid[], hash_a1, 2);
  if result ->> 'outcome' <> 'stale' then
    raise exception 'P2 FAILED: an answer hash was accepted as a new question';
  end if;

  ---------------------------------------------------------------------------
  -- The budget. Two questions, and the third is refused without consuming it.
  ---------------------------------------------------------------------------
  result := public.begin_agent_clarification_question(
    task_1, responder, step_q2, 'And which deployment target?', 'contradiction',
    '{}'::uuid[], hash_q2, 2);
  if result ->> 'outcome' <> 'route_dialogue'
     or (result -> 'task' ->> 'questionsUsed')::int <> 2 then
    raise exception 'B1 FAILED: the second question was refused: %', result;
  end if;

  result := public.record_agent_clarification_dialogue_result(
    task_1, requester, step_q2, null, 3, 'answered', 'Staging.',
    null, null, null, null, hash_a2);
  if result ->> 'outcome' <> 'resume_recipient'
     or (result -> 'task' ->> 'followUpRounds')::int <> 4 then
    raise exception 'B2 FAILED: the second answer did not resume the recipient: %', result;
  end if;

  result := public.begin_agent_clarification_question(
    task_1, responder, step_q3, 'One more thing?', 'ambiguity',
    '{}'::uuid[], hash_q3, 4);
  if result ->> 'outcome' <> 'exhausted' then
    raise exception 'B3 FAILED: a third question was allowed: %', result;
  end if;

  select questions_used into used
    from public.agent_clarification_tasks where task_id = task_1;
  select follow_up_rounds into rounds
    from public.collaboration_tasks where task_id = task_1;
  if used <> 2 or rounds <> 4 then
    raise exception 'B4 FAILED: the refused third question still consumed budget (% / %)',
      used, rounds;
  end if;
  if exists (select 1 from public.agent_clarification_steps where step_id = step_q3) then
    raise exception 'B5 FAILED: the refused third question still created a step';
  end if;

  -- The column check is the second line of defence, independent of the RPC.
  begin
    update public.agent_clarification_tasks
       set questions_used = 3 where task_id = task_1;
    raise exception 'B6 FAILED: the questions_used column accepted a third question';
  exception when check_violation then
    null;
  end;

  ---------------------------------------------------------------------------
  -- Retention. Terminating deletes the text and keeps the audit trail.
  ---------------------------------------------------------------------------
  result := public.stop_agent_clarification(task_1, outsider, true);
  if result ->> 'outcome' <> 'unavailable' then
    raise exception 'S1 FAILED: a non-participant stopped the exchange';
  end if;

  result := public.stop_agent_clarification(task_1, responder, true);
  if result ->> 'outcome' <> 'stopped' then
    raise exception 'S2 FAILED: a participant could not stop the exchange';
  end if;

  task := public.agent_clarification_task_json(task_1);
  if task ->> 'state' <> 'completed'
     or task ->> 'expectedUserId' is not null
     or task ->> 'expectedLane' is not null
     or task ->> 'currentStepId' is not null then
    raise exception 'S3 FAILED: the terminal task kept routing state: %', task;
  end if;

  if exists (select 1 from public.agent_clarification_payloads where task_id = task_1) then
    raise exception 'S4 FAILED: question and answer text survived termination';
  end if;

  if (select count(*) from public.agent_clarification_steps where task_id = task_1) <> 2 then
    raise exception 'S5 FAILED: the structural audit trail was deleted with the text';
  end if;
  if not exists (select 1 from public.agent_clarification_steps
    where step_id = step_q1 and content_hash = hash_q1 and answer_hash = hash_a1) then
    raise exception 'S6 FAILED: the audit hashes did not survive termination';
  end if;
  if jsonb_array_length(task -> 'steps') <> 2
     or (task -> 'steps' -> 0 ->> 'question') is not null
     or (task -> 'steps' -> 0 ->> 'answer') is not null
     or (task -> 'steps' -> 0 ->> 'contentHash') <> hash_q1 then
    raise exception 'S7 FAILED: the terminal projection still carries text: %',
      task -> 'steps';
  end if;

  if not exists (select 1 from public.agent_dialogue_origin_grants
    where origin_shared_message_id = origin_1 and revoked_at is not null) then
    raise exception 'S8 FAILED: the origin grant outlived the exchange it authorised';
  end if;

  result := public.stop_agent_clarification(task_1, requester, false);
  if result ->> 'outcome' <> 'already_terminal' then
    raise exception 'S9 FAILED: a terminal exchange was stopped twice';
  end if;

  result := public.begin_agent_clarification_question(
    task_1, responder, step_q3, 'After the end?', 'ambiguity',
    '{}'::uuid[], hash_q3, 6);
  if result ->> 'outcome' <> 'unavailable' then
    raise exception 'S10 FAILED: a terminal exchange accepted a new question';
  end if;

  ---------------------------------------------------------------------------
  -- Escalation. human_required parks the step for a person, who resumes it.
  ---------------------------------------------------------------------------
  perform public.grant_agent_dialogue_originator(origin_2, requester, 'claude', null);
  perform public.activate_agent_clarification(task_2, responder, 'codex', null);
  result := public.begin_agent_clarification_question(
    task_2, responder, step_q4, 'Do we have approval to touch billing?',
    'missing_intent', '{}'::uuid[], hash_q4, 0);
  if result ->> 'outcome' <> 'route_dialogue' then
    raise exception 'H1 FAILED: the second task could not ask: %', result;
  end if;

  result := public.record_agent_clarification_dialogue_result(
    task_2, requester, step_q4, null, 1, 'human_required', null, null, null,
    null, null, null);
  if result ->> 'outcome' <> 'unavailable' then
    raise exception 'H2 FAILED: a null escalation reason passed the gate';
  end if;

  result := public.record_agent_clarification_dialogue_result(
    task_2, requester, step_q4, null, 1, 'human_required', null, null, null,
    null, 'private_context', null);
  task := result -> 'task';
  if result ->> 'outcome' <> 'human_required'
     or task ->> 'state' <> 'human_required'
     or task ->> 'expectedLane' <> 'human'
     or task ->> 'expectedUserId' <> requester::text
     or task ->> 'currentStepId' <> step_q4::text then
    raise exception 'H3 FAILED: escalation did not park for a human: %', task;
  end if;
  if not exists (select 1 from public.agent_clarification_steps
    where step_id = step_q4 and status = 'human_required'
      and human_required_reason = 'private_context' and answer_hash is null) then
    raise exception 'H4 FAILED: the escalated step was not marked correctly';
  end if;

  result := public.continue_agent_clarification(
    task_2, responder, step_q4, 'Yes, approved last week.', hash_h4,
    (task ->> 'version')::int);
  if result ->> 'outcome' <> 'unavailable' then
    raise exception 'H5 FAILED: the wrong human answered the escalation';
  end if;

  result := public.continue_agent_clarification(
    task_2, requester, step_q4, null, hash_h4, (task ->> 'version')::int);
  if result ->> 'outcome' <> 'unavailable' then
    raise exception 'H6 FAILED: a null human answer passed the gate';
  end if;

  result := public.continue_agent_clarification(
    task_2, requester, step_q4, 'Yes, approved last week.', null,
    (task ->> 'version')::int);
  if result ->> 'outcome' <> 'unavailable' then
    raise exception 'H7 FAILED: a null answer hash passed the gate';
  end if;

  result := public.continue_agent_clarification(
    task_2, requester, step_q4, 'Yes, approved last week.', hash_h4,
    (task ->> 'version')::int);
  task := result -> 'task';
  if result ->> 'outcome' <> 'resume_recipient'
     or task ->> 'state' <> 'recipient_running'
     or task ->> 'expectedUserId' <> responder::text
     or task ->> 'expectedLane' <> 'private_work'
     or task ->> 'currentStepId' is not null then
    raise exception 'H8 FAILED: the human answer did not resume the recipient: %', task;
  end if;
  if not exists (select 1 from public.agent_clarification_steps s
    join public.agent_clarification_payloads p on p.step_id = s.step_id
    where s.step_id = step_q4 and s.status = 'resolved'
      and s.human_required_reason is null and s.answer_hash = hash_h4
      and p.answer = 'Yes, approved last week.') then
    raise exception 'H9 FAILED: the escalated step did not resolve cleanly';
  end if;

  ---------------------------------------------------------------------------
  -- Nested dialogue. A peer may answer a question with a question, and the
  -- answer to that one has to hand control back to whoever is still waiting on
  -- the original -- not to the recipient, and not to nobody.
  ---------------------------------------------------------------------------
  perform public.grant_agent_dialogue_originator(origin_4, requester, 'codex', null);
  perform public.activate_agent_clarification(task_4, responder, 'claude', null);
  result := public.begin_agent_clarification_question(
    task_4, responder, step_q6, 'Which branch should this target?', 'ambiguity',
    '{}'::uuid[], hash_q6, 0);
  if result ->> 'outcome' <> 'route_dialogue' then
    raise exception 'N1 FAILED: the fourth task could not ask: %', result;
  end if;

  result := public.record_agent_clarification_dialogue_result(
    task_4, requester, step_q6, step_q7, 1, 'counter_question', null, null,
    'ambiguity', '{}'::uuid[], null, hash_q7);
  if result ->> 'outcome' <> 'unavailable' then
    raise exception 'N2 FAILED: a null counter question passed the gate';
  end if;

  result := public.record_agent_clarification_dialogue_result(
    task_4, requester, step_q6, step_q7, 1, 'counter_question', 'An answer too',
    'And which environment?', 'ambiguity', '{}'::uuid[], null, hash_q7);
  if result ->> 'outcome' <> 'unavailable' then
    raise exception 'N3 FAILED: a counter question carrying an answer was accepted';
  end if;

  result := public.record_agent_clarification_dialogue_result(
    task_4, requester, step_q6, step_q7, 1, 'counter_question', null,
    'And which environment?', 'ambiguity', '{}'::uuid[], null, hash_q7);
  task := result -> 'task';
  if result ->> 'outcome' <> 'route_dialogue'
     or (task ->> 'questionsUsed')::int <> 2
     or task ->> 'expectedUserId' <> responder::text
     or task ->> 'currentStepId' <> step_q7::text
     or (task ->> 'followUpRounds')::int <> 2 then
    raise exception 'N4 FAILED: the counter question routed wrongly: %', task;
  end if;
  if not exists (select 1 from public.agent_clarification_steps
    where step_id = step_q7 and parent_step_id = step_q6 and sequence = 2
      and asked_by_user_id = requester and asked_to_user_id = responder) then
    raise exception 'N5 FAILED: the counter question was not parented to the original';
  end if;

  -- The branch that matters: the original question is still pending, so this
  -- answer must return control to the peer waiting on it.
  result := public.record_agent_clarification_dialogue_result(
    task_4, responder, step_q7, null, 2, 'answered', 'Production.',
    null, null, null, null, hash_a7);
  task := result -> 'task';
  if result ->> 'outcome' <> 'route_dialogue'
     or task ->> 'state' <> 'dialogue_running'
     or task ->> 'expectedUserId' <> requester::text
     or task ->> 'expectedLane' <> 'clarification_dialogue'
     or task ->> 'currentStepId' <> step_q6::text then
    raise exception 'N6 FAILED: answering the counter question did not return to the parent: %',
      task;
  end if;

  -- And with nothing left pending above it, the loop hands back to the recipient.
  result := public.record_agent_clarification_dialogue_result(
    task_4, requester, step_q6, null, 3, 'answered', 'The release branch.',
    null, null, null, null, hash_a6);
  task := result -> 'task';
  if result ->> 'outcome' <> 'resume_recipient'
     or task ->> 'state' <> 'recipient_running'
     or task ->> 'expectedUserId' <> responder::text
     or task ->> 'expectedLane' <> 'private_work'
     or task ->> 'currentStepId' is not null then
    raise exception 'N7 FAILED: the last answer did not resume the recipient: %', task;
  end if;
  if exists (select 1 from public.agent_clarification_steps
    where task_id = task_4 and status <> 'resolved') then
    raise exception 'N8 FAILED: the nested dialogue left a step unresolved';
  end if;

  ---------------------------------------------------------------------------
  -- Expiry, and the sweep that catches the exchanges nobody terminates.
  ---------------------------------------------------------------------------
  perform public.grant_agent_dialogue_originator(origin_3, requester, 'codex', null);
  perform public.activate_agent_clarification(task_3, responder, 'claude', null);
  perform public.begin_agent_clarification_question(
    task_3, responder, step_q5, 'Anything else?', 'ambiguity',
    '{}'::uuid[], hash_q5, 0);
  if not exists (select 1 from public.agent_clarification_payloads where task_id = task_3) then
    raise exception 'E1 FAILED: the third task never stored a payload to expire';
  end if;

  update public.collaboration_tasks
     set expires_at = now() - interval '1 minute' where task_id = task_3;

  result := public.load_agent_clarification(task_3, requester);
  task := result -> 'task';
  if result ->> 'outcome' <> 'available'
     or task ->> 'state' <> 'expired'
     or task ->> 'expectedUserId' is not null
     or task ->> 'expectedLane' is not null
     or task ->> 'currentStepId' is not null then
    raise exception 'E2 FAILED: an expired task was not closed on read: %', task;
  end if;
  if exists (select 1 from public.agent_clarification_payloads where task_id = task_3) then
    raise exception 'E3 FAILED: expiry left question text behind';
  end if;

  if public.load_agent_clarification(task_3, outsider) ->> 'outcome' <> 'unavailable' then
    raise exception 'E4 FAILED: a non-participant loaded the task';
  end if;

  -- The sweep is what covers an exchange both people abandon: no RPC ever runs
  -- against it again, so nothing else would ever delete its text.
  update public.agent_clarification_payloads
     set expires_at = now() - interval '1 minute' where task_id = task_2;
  swept := public.sweep_expired_agent_clarification_payloads();
  if swept < 1 then
    raise exception 'E5 FAILED: the sweep deleted nothing';
  end if;
  if exists (select 1 from public.agent_clarification_payloads where expires_at <= now()) then
    raise exception 'E6 FAILED: expired payloads survived the sweep';
  end if;

  ---------------------------------------------------------------------------
  -- Listing, scoped to participants.
  ---------------------------------------------------------------------------
  if jsonb_array_length(public.list_agent_clarifications(
       requester, 1345851099, 'a3000000-0000-4000-8000-000000000001')) <> 4 then
    raise exception 'L1 FAILED: a participant could not list their exchanges';
  end if;
  if jsonb_array_length(public.list_agent_clarifications(
       outsider, 1345851099, 'a3000000-0000-4000-8000-000000000001')) <> 0 then
    raise exception 'L2 FAILED: a non-participant listed exchanges';
  end if;

  ---------------------------------------------------------------------------
  -- Table invariants, independent of any RPC.
  ---------------------------------------------------------------------------
  begin
    insert into public.agent_clarification_steps (
      step_id, task_id, sequence, asked_by_user_id, asked_to_user_id,
      status, reason_code, content_hash, created_at
    ) values (
      'a6000000-0000-4000-8000-000000000009', task_2, 2, requester, requester,
      'pending', 'ambiguity', repeat('ee', 32), now()
    );
    raise exception 'I1 FAILED: a step was allowed to ask its own author';
  exception when check_violation then
    get stacked diagnostics constraint_hit = constraint_name;
    if constraint_hit <> 'agent_clarification_step_distinct_peers' then
      raise exception 'I1 FAILED: rejected by % rather than the peer check', constraint_hit;
    end if;
  end;

  begin
    update public.agent_clarification_steps
       set answer_hash = null where step_id = step_q1;
    raise exception 'I2 FAILED: a resolved step was allowed to drop its answer hash';
  exception when check_violation then
    get stacked diagnostics constraint_hit = constraint_name;
    if constraint_hit <> 'agent_clarification_step_resolution_shape' then
      raise exception 'I2 FAILED: rejected by % rather than the resolution shape',
        constraint_hit;
    end if;
  end;

  begin
    update public.agent_clarification_tasks
       set expected_lane = 'human' where task_id = task_1;
    raise exception 'I3 FAILED: a terminal task was allowed to keep a lane';
  exception when check_violation then
    get stacked diagnostics constraint_hit = constraint_name;
    if constraint_hit <> 'agent_clarification_terminal_shape' then
      raise exception 'I3 FAILED: rejected by % rather than the terminal shape',
        constraint_hit;
    end if;
  end;

  ---------------------------------------------------------------------------
  -- Schema shape. Text lives only where it can be deleted.
  ---------------------------------------------------------------------------
  select count(*) into offenders
    from information_schema.columns
   where table_schema = 'public'
     and table_name in ('agent_clarification_tasks', 'agent_clarification_steps',
                        'agent_dialogue_origin_grants')
     and column_name in ('question', 'answer', 'body', 'text', 'summary',
                         'reasoning', 'content', 'transcript');
  if offenders <> 0 then
    raise exception 'F1 FAILED: durable clarification tables carry free text';
  end if;

  select count(*) into offenders
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'agent_clarification_payloads'
     and column_name in ('question', 'answer');
  if offenders <> 2 then
    raise exception 'F2 FAILED: question and answer text moved out of the payload table';
  end if;

  -- The migration header forbids provider session IDs, local paths, repository
  -- bytes and private reasoning from this schema.
  select count(*) into offenders
    from information_schema.columns
   where table_schema = 'public'
     and table_name in ('agent_clarification_tasks', 'agent_clarification_steps',
                        'agent_clarification_payloads', 'agent_dialogue_origin_grants')
     and column_name ~* '(session|path|credential|command|executable|token|secret|blob|diff|patch)';
  if offenders <> 0 then
    raise exception 'F3 FAILED: clarification tables carry local or private fields';
  end if;

  select count(*) into offenders
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('agent_clarification_tasks', 'agent_clarification_steps',
                       'agent_clarification_payloads', 'agent_dialogue_origin_grants')
     and not c.relrowsecurity;
  if offenders <> 0 then
    raise exception 'F4 FAILED: row level security is off on % clarification tables',
      offenders;
  end if;

  ---------------------------------------------------------------------------
  -- Access. Browser roles reach none of this; the backend reaches all of it.
  --
  -- Table DELETE is deliberately not asserted: the CI harness blanket-grants
  -- select/insert/update/delete on every public table to service_role after
  -- the migrations run, so a narrower table grant is not observable from here.
  -- Function EXECUTE is observable, and it is the grant that matters -- these
  -- tables are only ever reached through the functions, and PostgreSQL grants
  -- EXECUTE to PUBLIC by default, so each revoke below is load-bearing.
  ---------------------------------------------------------------------------
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_relation in array array[
      'public.agent_clarification_tasks', 'public.agent_clarification_steps',
      'public.agent_clarification_payloads', 'public.agent_dialogue_origin_grants'
    ] loop
      foreach v_privilege in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
        if has_table_privilege(v_role, v_relation, v_privilege) then
          raise exception 'G1 FAILED: % holds % on %', v_role, v_privilege, v_relation;
        end if;
      end loop;
    end loop;

    foreach v_signature in array signatures loop
      if has_function_privilege(v_role, v_signature, 'EXECUTE') then
        raise exception 'G2 FAILED: % can execute %', v_role, v_signature;
      end if;
    end loop;
  end loop;

  foreach v_signature in array signatures loop
    if not has_function_privilege('service_role', v_signature, 'EXECUTE') then
      raise exception 'G3 FAILED: the backend cannot execute %', v_signature;
    end if;
  end loop;

  foreach v_relation in array array[
    'public.agent_clarification_tasks', 'public.agent_clarification_steps',
    'public.agent_clarification_payloads', 'public.agent_dialogue_origin_grants'
  ] loop
    foreach v_privilege in array array['SELECT', 'INSERT', 'UPDATE'] loop
      if not has_table_privilege('service_role', v_relation, v_privilege) then
        raise exception 'G4 FAILED: the backend lacks % on %', v_privilege, v_relation;
      end if;
    end loop;
  end loop;
end;
$$;

select 'all agent clarification loop tests passed' as result;
rollback;
