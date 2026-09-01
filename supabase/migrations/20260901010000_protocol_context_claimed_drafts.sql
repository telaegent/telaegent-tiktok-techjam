-- Private draft execution claims the row before dispatching a connector job.
-- The durable context loaders must therefore accept `agent_working`: requiring
-- only the pre-claim states made every real POST /api/drafts/:id/run resolve to
-- SQL NULL even though all owner, repository and conversation rows existed.

create or replace function public.load_sender_protocol_context(
  p_user_id uuid,
  p_github_repository_id bigint,
  p_conversation_id uuid,
  p_draft_id uuid,
  p_message_limit integer
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with selected_draft as (
    select draft.*
    from public.private_drafts draft
    where draft.draft_id = p_draft_id
      and draft.owner_user_id = p_user_id
      and draft.github_repository_id = p_github_repository_id
      and draft.conversation_id = p_conversation_id
      and draft.role = 'sender'
      and draft.rough_message is not null
      and draft.state in ('created', 'agent_working', 'needs_clarification')
  ),
  selected_project as (
    select project.*
    from public.repository_projects project
    join public.project_conversations conversation
      on conversation.project_id = project.project_id
    where project.github_repository_id = p_github_repository_id
      and project.status = 'active'
      and conversation.conversation_id = p_conversation_id
      and conversation.status = 'active'
  ),
  selected_binding as (
    select binding.*
    from public.runtime_bindings binding
    join selected_project project on project.project_id = binding.project_id
    where binding.user_id = p_user_id
      and binding.github_repository_id = p_github_repository_id
      and binding.status = 'ready'
      and binding.commit_sha is not null
      and binding.last_verified_at is not null
  ),
  owner_identity as (
    select identity.github_login
    from public.account_github_identities identity
    where identity.user_id = p_user_id
  ),
  collaborator_identity as (
    select identity.github_login
    from public.conversation_participants participant
    join public.account_github_identities identity
      on identity.user_id = participant.user_id
    where participant.conversation_id = p_conversation_id
      and participant.user_id <> p_user_id
    order by participant.user_id
    limit 1
  ),
  bounded_messages as (
    select message.*, identity.github_login
    from public.shared_messages message
    join public.account_github_identities identity
      on identity.user_id = message.sender_user_id
    where message.conversation_id = p_conversation_id
      and message.github_repository_id = p_github_repository_id
    order by message.sent_at desc, message.message_id desc
    limit case when p_message_limit between 1 and 200 then p_message_limit else 0 end
  )
  select jsonb_build_object(
    'role', 'sender',
    'facts', jsonb_build_object(
      'repositoryFullName', project.repository_full_name,
      'githubRepositoryId', project.github_repository_id::text,
      'branch', coalesce(binding.current_branch, 'detached'),
      'commit', binding.commit_sha,
      'ownerName', owner.github_login,
      'collaboratorName', collaborator.github_login
    ),
    'sharedHistory', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', message.message_id,
        'author', message.github_login,
        'origin', 'agent',
        'text', message.body,
        'at', to_char(message.sent_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) order by message.sent_at, message.message_id)
      from bounded_messages message
    ), '[]'::jsonb),
    'projectFacts', jsonb_build_array(
      'Repository: ' || project.repository_full_name,
      'Default branch: ' || project.default_branch,
      'Current branch: ' || coalesce(binding.current_branch, 'detached'),
      'Current commit: ' || binding.commit_sha
    ),
    'privateTurns', draft.private_turns,
    'ownerInput', draft.rough_message
  )
  from selected_draft draft
  cross join selected_project project
  cross join selected_binding binding
  cross join owner_identity owner
  cross join collaborator_identity collaborator;
$$;

create or replace function public.load_recipient_protocol_context(
  p_user_id uuid,
  p_github_repository_id bigint,
  p_conversation_id uuid,
  p_draft_id uuid,
  p_message_limit integer
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with selected_draft as (
    select draft.*
    from public.private_drafts draft
    where draft.draft_id = p_draft_id
      and draft.owner_user_id = p_user_id
      and draft.github_repository_id = p_github_repository_id
      and draft.conversation_id = p_conversation_id
      and draft.role = 'recipient'
      and draft.incoming_message_id is not null
      and draft.state in ('created', 'agent_working', 'needs_clarification')
  ),
  incoming as (
    select message.*, identity.github_login
    from public.shared_messages message
    join selected_draft draft
      on draft.incoming_message_id = message.message_id
    join public.account_github_identities identity
      on identity.user_id = message.sender_user_id
    where message.conversation_id = p_conversation_id
      and message.github_repository_id = p_github_repository_id
      and message.sender_user_id <> p_user_id
  ),
  selected_project as (
    select project.*
    from public.repository_projects project
    join public.project_conversations conversation
      on conversation.project_id = project.project_id
    where project.github_repository_id = p_github_repository_id
      and project.status = 'active'
      and conversation.conversation_id = p_conversation_id
      and conversation.status = 'active'
  ),
  selected_binding as (
    select binding.*
    from public.runtime_bindings binding
    join selected_project project on project.project_id = binding.project_id
    where binding.user_id = p_user_id
      and binding.github_repository_id = p_github_repository_id
      and binding.status = 'ready'
      and binding.commit_sha is not null
      and binding.last_verified_at is not null
  ),
  owner_identity as (
    select identity.github_login
    from public.account_github_identities identity
    where identity.user_id = p_user_id
  ),
  -- Strictly earlier than the message being answered. The incoming message is
  -- deliberately absent here: it is delivered once, inside the untrusted data
  -- envelope, and must not also appear as ordinary trusted history.
  bounded_messages as (
    select message.*, identity.github_login
    from public.shared_messages message
    cross join incoming
    join public.account_github_identities identity
      on identity.user_id = message.sender_user_id
    where message.conversation_id = p_conversation_id
      and message.github_repository_id = p_github_repository_id
      and (message.sent_at, message.message_id)
          < (incoming.sent_at, incoming.message_id)
    order by message.sent_at desc, message.message_id desc
    limit case when p_message_limit between 1 and 200 then p_message_limit else 0 end
  )
  select jsonb_build_object(
    'role', 'recipient',
    'facts', jsonb_build_object(
      'repositoryFullName', project.repository_full_name,
      'githubRepositoryId', project.github_repository_id::text,
      'branch', coalesce(binding.current_branch, 'detached'),
      'commit', binding.commit_sha,
      'ownerName', owner.github_login,
      'collaboratorName', incoming.github_login
    ),
    'sharedHistory', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', message.message_id,
        'author', message.github_login,
        'origin', 'agent',
        'text', message.body,
        'at', to_char(message.sent_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) order by message.sent_at, message.message_id)
      from bounded_messages message
    ), '[]'::jsonb),
    'projectFacts', jsonb_build_array(
      'Repository: ' || project.repository_full_name,
      'Default branch: ' || project.default_branch,
      'Current branch: ' || coalesce(binding.current_branch, 'detached'),
      'Current commit: ' || binding.commit_sha
    ),
    'privateTurns', draft.private_turns,
    'incomingMessage', incoming.body
  )
  from selected_draft draft
  cross join incoming
  cross join selected_project project
  cross join selected_binding binding
  cross join owner_identity owner;
$$;
