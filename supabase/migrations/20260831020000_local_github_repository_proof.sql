-- Persists the safe result of LOCAL GitHub CLI repository proof.
--
-- The cloud never runs `gh`, receives a credential, remote URL, local path,
-- repository content, or raw command output. Connector authentication resolves
-- p_user_id and p_connector_instance_id before this RPC is called.

alter table public.runtime_bindings
  add column connector_instance_id text,
  add column current_branch text,
  add column commit_sha text,
  add column repository_permission text,
  add column last_verified_at timestamptz,
  add column last_seen_at timestamptz,
  add column unavailable_reason text,
  add column unavailable_at timestamptz,
  add constraint runtime_bindings_connector_instance_format check (
    connector_instance_id is null or
    (length(connector_instance_id) between 16 and 128 and
     connector_instance_id ~ '^[A-Za-z0-9_-]+$')
  ),
  add constraint runtime_bindings_commit_sha_format check (
    commit_sha is null or commit_sha ~ '^[0-9a-f]{40}$'
  ),
  add constraint runtime_bindings_repository_permission check (
    repository_permission is null or
    repository_permission in ('read', 'triage', 'write', 'maintain', 'admin')
  );

-- Preserve pre-migration unavailable rows without pretending they came from a
-- new connector observation.
update public.runtime_bindings
set unavailable_reason = 'legacy_unavailable',
    unavailable_at = clock_timestamp()
where status = 'unavailable';

alter table public.runtime_bindings
  add constraint runtime_bindings_unavailable_state check (
    (status = 'unavailable' and unavailable_reason is not null and unavailable_at is not null) or
    (status <> 'unavailable' and unavailable_reason is null and unavailable_at is null)
  );

create index runtime_bindings_connector_instance_idx
  on public.runtime_bindings (connector_instance_id)
  where connector_instance_id is not null;

create table public.repository_registration_proofs (
  proof_id uuid primary key,
  user_id uuid not null references public.user_accounts(user_id) on delete restrict,
  github_repository_id bigint not null check (github_repository_id > 0),
  connector_instance_id text not null check (
    length(connector_instance_id) between 16 and 128 and
    connector_instance_id ~ '^[A-Za-z0-9_-]+$'
  ),
  payload_digest bytea not null check (octet_length(payload_digest) = 32),
  github_connection_id uuid not null
    references public.github_connections(github_connection_id) on delete restrict,
  project_id uuid not null
    references public.repository_projects(project_id) on delete restrict,
  runtime_binding_id uuid not null
    references public.runtime_bindings(runtime_binding_id) on delete restrict,
  observed_at timestamptz not null,
  accepted_at timestamptz not null default clock_timestamp()
);

create index repository_registration_proofs_user_repo_idx
  on public.repository_registration_proofs
  (user_id, github_repository_id, accepted_at desc);

alter table public.repository_registration_proofs enable row level security;
revoke all on table public.repository_registration_proofs
  from public, anon, authenticated;
grant select, insert, delete on table public.repository_registration_proofs
  to service_role;

create or replace function public.register_local_github_repository_proof(
  p_user_id uuid,
  p_connector_instance_id text,
  p_proof_id uuid,
  p_payload_digest_hex text,
  p_observed_at timestamptz,
  p_github_user_id bigint,
  p_github_login text,
  p_github_repository_id bigint,
  p_repository_full_name text,
  p_visibility text,
  p_default_branch text,
  p_current_branch text,
  p_commit_sha text,
  p_permission text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_account_status text;
  v_identity_github_user_id bigint;
  v_connection public.github_connections%rowtype;
  v_project public.repository_projects%rowtype;
  v_access public.github_repository_access%rowtype;
  v_membership public.project_memberships%rowtype;
  v_binding public.runtime_bindings%rowtype;
  v_replay public.repository_registration_proofs%rowtype;
  v_digest bytea;
  v_connection_exists boolean := false;
  v_project_exists boolean := false;
  v_access_exists boolean := false;
  v_membership_exists boolean := false;
  v_binding_exists boolean := false;
begin
  if p_user_id is null or p_proof_id is null or p_observed_at is null or
     p_connector_instance_id is null or
     length(p_connector_instance_id) not between 16 and 128 or
     p_connector_instance_id !~ '^[A-Za-z0-9_-]+$' or
     p_payload_digest_hex is null or
     p_payload_digest_hex !~ '^[0-9a-f]{64}$' or
     p_github_user_id is null or p_github_user_id <= 0 or
     p_github_repository_id is null or p_github_repository_id <= 0 or
     p_github_login is null or
     p_github_login !~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$' or
     p_repository_full_name is null or length(p_repository_full_name) > 140 or
     p_repository_full_name !~ '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$' or
     p_repository_full_name ~ '/\.\.?$' or
     p_visibility not in ('public', 'private', 'internal') or
     p_default_branch is null or length(p_default_branch) not between 1 and 255 or
     p_current_branch is not null and length(p_current_branch) not between 1 and 255 or
     p_default_branch ~ '[[:cntrl:][:space:]]' or
     p_current_branch ~ '[[:cntrl:][:space:]]' or
     position('..' in p_default_branch) > 0 or
     position('..' in p_current_branch) > 0 or
     position('@{' in p_default_branch) > 0 or
     position('@{' in p_current_branch) > 0 or
     p_commit_sha is null or p_commit_sha !~ '^[0-9a-f]{40}$' or
     p_permission not in ('read', 'triage', 'write', 'maintain', 'admin') then
    raise exception using errcode = '22023', message = 'invalid repository proof';
  end if;
  v_digest := decode(p_payload_digest_hex, 'hex');

  -- Proof IDs are durable idempotency keys. A valid retry remains replayable
  -- even after the ordinary observation-freshness window has elapsed.
  perform pg_advisory_xact_lock(
    hashtextextended('repository-proof:' || p_proof_id::text, 0)
  );
  select * into v_replay
  from public.repository_registration_proofs
  where proof_id = p_proof_id;
  if found then
    if v_replay.user_id <> p_user_id or
       v_replay.github_repository_id <> p_github_repository_id or
       v_replay.connector_instance_id <> p_connector_instance_id or
       v_replay.payload_digest <> v_digest then
      return jsonb_build_object('error', 'proof_id_conflict');
    end if;
    perform 1
    from public.github_connections connection
    join public.github_repository_access access
      on access.user_id = v_replay.user_id
     and access.github_repository_id = v_replay.github_repository_id
    join public.project_memberships membership
      on membership.project_id = v_replay.project_id
     and membership.user_id = v_replay.user_id
    join public.runtime_bindings binding
      on binding.runtime_binding_id = v_replay.runtime_binding_id
     and binding.user_id = v_replay.user_id
     and binding.project_id = v_replay.project_id
     and binding.github_repository_id = v_replay.github_repository_id
    where connection.github_connection_id = v_replay.github_connection_id
      and connection.status = 'connected'
      and access.status = 'verified'
      and membership.status = 'active'
      and binding.status = 'ready'
      and binding.connector_instance_id = v_replay.connector_instance_id;
    if not found then
      return jsonb_build_object('error', 'proof_id_conflict');
    end if;
    return jsonb_build_object(
      'proofId', v_replay.proof_id::text,
      'githubConnectionId', v_replay.github_connection_id::text,
      'projectId', v_replay.project_id::text,
      'githubRepositoryId', v_replay.github_repository_id::text,
      'connectorBindingId', v_replay.runtime_binding_id::text,
      'accessStatus', 'verified',
      'membershipStatus', 'active',
      'bindingStatus', 'ready',
      'verifiedAt', to_char(v_replay.observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'replayed', true
    );
  end if;

  if p_observed_at < v_now - interval '15 minutes' or
     p_observed_at > v_now + interval '5 minutes' then
    return jsonb_build_object('error', 'stale_observation');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('github-repository:' || p_github_repository_id::text, 0)
  );

  select account.status, identity.github_user_id
    into v_account_status, v_identity_github_user_id
  from public.user_accounts account
  join public.account_github_identities identity on identity.user_id = account.user_id
  where account.user_id = p_user_id;
  if v_account_status is distinct from 'active' then
    return jsonb_build_object('error', 'account_inactive');
  end if;
  if v_identity_github_user_id is distinct from p_github_user_id then
    return jsonb_build_object('error', 'github_identity_mismatch');
  end if;
  if exists (
    select 1 from public.github_connections connection
    where connection.github_user_id = p_github_user_id
      and connection.user_id <> p_user_id
  ) then
    return jsonb_build_object('error', 'github_identity_mismatch');
  end if;

  select * into v_connection
  from public.github_connections
  where user_id = p_user_id
  for update;
  v_connection_exists := found;
  if v_connection_exists and v_connection.status = 'revoked' then
    return jsonb_build_object('error', 'github_connection_revoked');
  end if;
  if v_connection_exists and v_connection.github_user_id <> p_github_user_id then
    return jsonb_build_object('error', 'github_identity_mismatch');
  end if;

  select * into v_project
  from public.repository_projects
  where github_repository_id = p_github_repository_id
  for update;
  v_project_exists := found;
  if v_project_exists and v_project.status = 'archived' then
    return jsonb_build_object('error', 'project_archived');
  end if;

  select * into v_access
  from public.github_repository_access
  where user_id = p_user_id and github_repository_id = p_github_repository_id
  for update;
  v_access_exists := found;
  if v_access_exists and v_access.status = 'revoked' then
    return jsonb_build_object('error', 'repository_access_revoked');
  end if;
  if v_access_exists and p_observed_at < v_access.verified_at then
    return jsonb_build_object('error', 'stale_observation');
  end if;

  if v_project_exists then
    select * into v_membership
    from public.project_memberships
    where project_id = v_project.project_id and user_id = p_user_id
    for update;
    v_membership_exists := found;
    if v_membership_exists and v_membership.status = 'revoked' then
      return jsonb_build_object('error', 'membership_revoked');
    end if;

    select * into v_binding
    from public.runtime_bindings
    where project_id = v_project.project_id and user_id = p_user_id
    for update;
    v_binding_exists := found;
    if v_binding_exists and v_binding.status = 'revoked' then
      return jsonb_build_object('error', 'binding_revoked');
    end if;
    if v_binding_exists and v_binding.last_verified_at is not null and
       p_observed_at < v_binding.last_verified_at then
      return jsonb_build_object('error', 'stale_observation');
    end if;
  end if;

  -- All fail-closed checks are complete. Only now may the transaction mutate.
  if not v_connection_exists then
    insert into public.github_connections (
      user_id, github_user_id, github_login, status, connected_at, last_verified_at
    ) values (
      p_user_id, p_github_user_id, p_github_login, 'connected', v_now, p_observed_at
    ) returning * into v_connection;
  else
    update public.github_connections
      set github_login = p_github_login,
          status = 'connected',
          last_verified_at = greatest(coalesce(last_verified_at, p_observed_at), p_observed_at),
          revoked_at = null
    where github_connection_id = v_connection.github_connection_id
    returning * into v_connection;
  end if;

  if not v_project_exists then
    insert into public.repository_projects (
      github_repository_id, repository_full_name, visibility, default_branch, status
    ) values (
      p_github_repository_id, p_repository_full_name, p_visibility, p_default_branch, 'active'
    ) returning * into v_project;
  else
    update public.repository_projects
      set repository_full_name = p_repository_full_name,
          visibility = p_visibility,
          default_branch = p_default_branch
    where project_id = v_project.project_id
    returning * into v_project;
  end if;

  if not v_access_exists then
    insert into public.github_repository_access (
      user_id, github_connection_id, github_repository_id, status, verified_at
    ) values (
      p_user_id, v_connection.github_connection_id, p_github_repository_id, 'verified', p_observed_at
    ) returning * into v_access;
  else
    update public.github_repository_access
      set github_connection_id = v_connection.github_connection_id,
          status = 'verified',
          verified_at = p_observed_at,
          revoked_at = null
    where user_id = p_user_id and github_repository_id = p_github_repository_id
    returning * into v_access;
  end if;

  if not v_membership_exists then
    insert into public.project_memberships (project_id, user_id, status)
    values (v_project.project_id, p_user_id, 'active')
    returning * into v_membership;
  else
    update public.project_memberships
      set status = 'active', revoked_at = null
    where project_id = v_project.project_id and user_id = p_user_id
    returning * into v_membership;
  end if;

  if not v_binding_exists then
    insert into public.runtime_bindings (
      user_id, project_id, github_repository_id, status,
      connector_instance_id, current_branch, commit_sha, repository_permission,
      last_verified_at, last_seen_at
    ) values (
      p_user_id, v_project.project_id, p_github_repository_id, 'ready',
      p_connector_instance_id, p_current_branch, p_commit_sha, p_permission,
      p_observed_at, v_now
    ) returning * into v_binding;
  else
    update public.runtime_bindings
      set status = 'ready',
          connector_instance_id = p_connector_instance_id,
          current_branch = p_current_branch,
          commit_sha = p_commit_sha,
          repository_permission = p_permission,
          last_verified_at = p_observed_at,
          last_seen_at = v_now,
          unavailable_reason = null,
          unavailable_at = null
    where runtime_binding_id = v_binding.runtime_binding_id
    returning * into v_binding;
  end if;

  insert into public.repository_registration_proofs (
    proof_id, user_id, github_repository_id, connector_instance_id,
    payload_digest, github_connection_id, project_id, runtime_binding_id,
    observed_at
  ) values (
    p_proof_id, p_user_id, p_github_repository_id, p_connector_instance_id,
    v_digest, v_connection.github_connection_id, v_project.project_id,
    v_binding.runtime_binding_id, p_observed_at
  );

  return jsonb_build_object(
    'proofId', p_proof_id::text,
    'githubConnectionId', v_connection.github_connection_id::text,
    'projectId', v_project.project_id::text,
    'githubRepositoryId', p_github_repository_id::text,
    'connectorBindingId', v_binding.runtime_binding_id::text,
    'accessStatus', 'verified',
    'membershipStatus', 'active',
    'bindingStatus', 'ready',
    'verifiedAt', to_char(p_observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'replayed', false
  );
end;
$$;

create or replace function public.mark_local_github_repository_unavailable(
  p_user_id uuid,
  p_connector_instance_id text,
  p_github_repository_id bigint,
  p_observed_at timestamptz,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_binding public.runtime_bindings%rowtype;
  v_access_status text;
  v_membership_status text;
  v_changed boolean;
begin
  if p_user_id is null or p_observed_at is null or
     p_connector_instance_id is null or
     p_connector_instance_id !~ '^[A-Za-z0-9_-]{16,128}$' or
     p_github_repository_id is null or p_github_repository_id <= 0 or
     p_reason not in (
       'github_auth_required', 'repository_access_lost',
       'repository_not_found', 'sso_reauthorization_required'
     ) or
     p_observed_at < v_now - interval '15 minutes' or
     p_observed_at > v_now + interval '5 minutes' then
    return jsonb_build_object('error', 'stale_observation');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('github-repository:' || p_github_repository_id::text, 0)
  );

  select binding.* into v_binding
  from public.runtime_bindings binding
  where binding.user_id = p_user_id
    and binding.github_repository_id = p_github_repository_id
    and binding.connector_instance_id = p_connector_instance_id
  for update;
  if not found then
    return jsonb_build_object('error', 'binding_not_owned');
  end if;
  if v_binding.status = 'revoked' then
    return jsonb_build_object('error', 'binding_revoked');
  end if;
  if v_binding.last_verified_at is not null and p_observed_at < v_binding.last_verified_at then
    return jsonb_build_object('error', 'stale_observation');
  end if;

  select access.status into v_access_status
  from public.github_repository_access access
  where access.user_id = p_user_id
    and access.github_repository_id = p_github_repository_id
  for update;
  if v_access_status = 'revoked' then
    return jsonb_build_object('error', 'repository_access_revoked');
  end if;

  select membership.status into v_membership_status
  from public.project_memberships membership
  where membership.project_id = v_binding.project_id
    and membership.user_id = p_user_id
  for update;
  if v_membership_status = 'revoked' then
    return jsonb_build_object('error', 'membership_revoked');
  end if;

  v_changed := v_binding.status <> 'unavailable' or
    v_binding.unavailable_reason is distinct from p_reason or
    v_binding.unavailable_at is null or
    p_observed_at > v_binding.unavailable_at;

  update public.github_repository_access
    set status = 'revalidation_required', revoked_at = null
  where user_id = p_user_id and github_repository_id = p_github_repository_id;
  update public.project_memberships
    set status = 'suspended', revoked_at = null
  where project_id = v_binding.project_id and user_id = p_user_id;
  update public.runtime_bindings
    set status = 'unavailable',
        last_seen_at = v_now,
        unavailable_reason = p_reason,
        unavailable_at = greatest(coalesce(unavailable_at, p_observed_at), p_observed_at)
  where runtime_binding_id = v_binding.runtime_binding_id;

  if p_reason in ('github_auth_required', 'sso_reauthorization_required') then
    update public.github_connections
      set status = 'reconnect_required', revoked_at = null
    where user_id = p_user_id and status <> 'revoked';
  end if;

  return jsonb_build_object(
    'githubRepositoryId', p_github_repository_id::text,
    'accessStatus', 'revalidation_required',
    'membershipStatus', 'suspended',
    'bindingStatus', 'unavailable',
    'changed', v_changed
  );
end;
$$;

revoke all on function public.register_local_github_repository_proof(
  uuid, text, uuid, text, timestamptz, bigint, text, bigint,
  text, text, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.mark_local_github_repository_unavailable(
  uuid, text, bigint, timestamptz, text
) from public, anon, authenticated;

grant execute on function public.register_local_github_repository_proof(
  uuid, text, uuid, text, timestamptz, bigint, text, bigint,
  text, text, text, text, text, text
) to service_role;
grant execute on function public.mark_local_github_repository_unavailable(
  uuid, text, bigint, timestamptz, text
) to service_role;
