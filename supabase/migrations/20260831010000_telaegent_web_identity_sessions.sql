-- GitHub establishes a Telaegent account identity. Supabase is persistence only:
-- it does not authenticate browser users and no Supabase Auth JWT is accepted.

alter table public.user_accounts
  drop constraint if exists user_accounts_user_id_fkey;

create table public.account_github_identities (
  user_id uuid primary key
    references public.user_accounts(user_id) on delete cascade,
  github_user_id bigint not null unique check (github_user_id > 0),
  github_login text not null
    check (github_login ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'),
  avatar_url text check (
    avatar_url is null or
    (length(avatar_url) <= 2048 and avatar_url ~ '^https://')
  ),
  verified_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table public.github_oauth_states (
  state_hash bytea primary key check (octet_length(state_hash) = 32),
  return_to text not null check (
    length(return_to) between 1 and 512 and
    return_to like '/%' and
    return_to not like '//%' and
    return_to !~ E'[\\r\\n]'
  ),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null check (expires_at > created_at)
);

create index github_oauth_states_expires_idx
  on public.github_oauth_states (expires_at);

create table public.web_sessions (
  session_id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    references public.user_accounts(user_id) on delete cascade,
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null check (expires_at > created_at),
  revoked_at timestamptz,
  check (revoked_at is null or revoked_at >= created_at)
);

create index web_sessions_user_active_idx
  on public.web_sessions (user_id, expires_at)
  where revoked_at is null;
create index web_sessions_expires_idx
  on public.web_sessions (expires_at);

alter table public.account_github_identities enable row level security;
alter table public.github_oauth_states enable row level security;
alter table public.web_sessions enable row level security;

revoke all on table public.account_github_identities from public, anon, authenticated;
revoke all on table public.github_oauth_states from public, anon, authenticated;
revoke all on table public.web_sessions from public, anon, authenticated;
grant select, insert, update, delete on table public.account_github_identities to service_role;
grant select, insert, update, delete on table public.github_oauth_states to service_role;
grant select, insert, update, delete on table public.web_sessions to service_role;

create or replace function public.create_github_oauth_state(
  p_state_hash_hex text,
  p_return_to text
)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  insert into public.github_oauth_states (state_hash, return_to, expires_at)
  values (
    decode(p_state_hash_hex, 'hex'),
    p_return_to,
    statement_timestamp() + interval '10 minutes'
  );
$$;

create or replace function public.consume_github_oauth_state(
  p_state_hash_hex text
)
returns text
language sql
volatile
security invoker
set search_path = ''
as $$
  delete from public.github_oauth_states
  where state_hash = decode(p_state_hash_hex, 'hex')
    and expires_at > statement_timestamp()
  returning return_to;
$$;

create or replace function public.complete_github_oauth_login(
  p_github_user_id bigint,
  p_github_login text,
  p_avatar_url text,
  p_session_token_hash_hex text,
  p_session_ttl_seconds integer
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_status text;
begin
  if p_session_ttl_seconds not between 3600 and 2592000 then
    raise exception using
      errcode = '22023',
      message = 'session TTL is outside the allowed range';
  end if;

  -- Serialize concurrent first logins for the same stable GitHub identity.
  perform pg_advisory_xact_lock(p_github_user_id);

  select identity.user_id
    into v_user_id
  from public.account_github_identities as identity
  where identity.github_user_id = p_github_user_id;

  if v_user_id is null then
    v_user_id := gen_random_uuid();
    insert into public.user_accounts (user_id, status)
    values (v_user_id, 'active');

    insert into public.account_github_identities (
      user_id, github_user_id, github_login, avatar_url
    ) values (
      v_user_id, p_github_user_id, p_github_login, p_avatar_url
    );
  else
    update public.account_github_identities
      set github_login = p_github_login,
          avatar_url = p_avatar_url,
          verified_at = clock_timestamp(),
          updated_at = clock_timestamp()
    where user_id = v_user_id;
  end if;

  select account.status into v_status
  from public.user_accounts as account
  where account.user_id = v_user_id;

  if v_status is distinct from 'active' then
    return null;
  end if;

  insert into public.web_sessions (user_id, token_hash, expires_at)
  values (
    v_user_id,
    decode(p_session_token_hash_hex, 'hex'),
    statement_timestamp() + make_interval(secs => p_session_ttl_seconds)
  );

  return jsonb_build_object(
    'userId', v_user_id::text,
    'githubUserId', p_github_user_id::text,
    'githubLogin', p_github_login,
    'avatarUrl', p_avatar_url
  );
end;
$$;

create or replace function public.load_telaegent_web_session(
  p_session_token_hash_hex text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'userId', account.user_id::text,
    'githubUserId', identity.github_user_id::text,
    'githubLogin', identity.github_login,
    'avatarUrl', identity.avatar_url
  )
  from public.web_sessions as session
  join public.user_accounts as account on account.user_id = session.user_id
  join public.account_github_identities as identity on identity.user_id = account.user_id
  where session.token_hash = decode(p_session_token_hash_hex, 'hex')
    and session.revoked_at is null
    and session.expires_at > statement_timestamp()
    and account.status = 'active'
  limit 1;
$$;

create or replace function public.revoke_telaegent_web_session(
  p_session_token_hash_hex text
)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  with revoked as (
    update public.web_sessions
      set revoked_at = clock_timestamp()
    where token_hash = decode(p_session_token_hash_hex, 'hex')
      and revoked_at is null
    returning 1
  )
  select exists(select 1 from revoked);
$$;

create or replace function public.prune_telaegent_identity_records()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_oauth_states integer;
  v_web_sessions integer;
begin
  delete from public.github_oauth_states
  where expires_at <= statement_timestamp();
  get diagnostics v_oauth_states = row_count;

  -- Retain recently expired/revoked rows briefly for incident diagnosis while
  -- keeping unbounded session history out of the primary store.
  delete from public.web_sessions
  where expires_at <= statement_timestamp() - interval '7 days'
     or revoked_at <= statement_timestamp() - interval '7 days';
  get diagnostics v_web_sessions = row_count;

  return jsonb_build_object(
    'oauthStatesDeleted', v_oauth_states,
    'webSessionsDeleted', v_web_sessions
  );
end;
$$;

revoke all on function public.create_github_oauth_state(text, text)
  from public, anon, authenticated;
revoke all on function public.consume_github_oauth_state(text)
  from public, anon, authenticated;
revoke all on function public.complete_github_oauth_login(bigint, text, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.load_telaegent_web_session(text)
  from public, anon, authenticated;
revoke all on function public.revoke_telaegent_web_session(text)
  from public, anon, authenticated;
revoke all on function public.prune_telaegent_identity_records()
  from public, anon, authenticated;

grant execute on function public.create_github_oauth_state(text, text)
  to service_role;
grant execute on function public.consume_github_oauth_state(text)
  to service_role;
grant execute on function public.complete_github_oauth_login(bigint, text, text, text, integer)
  to service_role;
grant execute on function public.load_telaegent_web_session(text)
  to service_role;
grant execute on function public.revoke_telaegent_web_session(text)
  to service_role;
grant execute on function public.prune_telaegent_identity_records()
  to service_role;
