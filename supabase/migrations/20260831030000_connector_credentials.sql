-- Dedicated, revocable credentials for the outbound local connector.
-- Raw bearer credentials never enter the database; only SHA-256 hashes do.

create table public.connector_credentials (
  credential_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.user_accounts(user_id) on delete cascade,
  connector_instance_id text not null check (
    length(connector_instance_id) between 16 and 128 and
    connector_instance_id ~ '^[A-Za-z0-9_-]+$'
  ),
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null check (expires_at > created_at),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  check (revoked_at is null or revoked_at >= created_at)
);

create index connector_credentials_active_instance_idx
  on public.connector_credentials (user_id, connector_instance_id, expires_at)
  where revoked_at is null;
create index connector_credentials_expiry_idx
  on public.connector_credentials (expires_at);

alter table public.connector_credentials enable row level security;
revoke all on table public.connector_credentials from public, anon, authenticated;
grant select, insert, update, delete on table public.connector_credentials to service_role;

create or replace function public.create_connector_credential(
  p_user_id uuid,
  p_connector_instance_id text,
  p_token_hash_hex text,
  p_ttl_seconds integer
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if p_connector_instance_id !~ '^[A-Za-z0-9_-]{16,128}$' or
     p_token_hash_hex !~ '^[0-9a-f]{64}$' or
     p_ttl_seconds not between 3600 and 2592000 or
     not exists (
       select 1 from public.user_accounts account
       where account.user_id = p_user_id and account.status = 'active'
     ) then
    return false;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('connector-credential:' || p_user_id::text || ':' || p_connector_instance_id, 0)
  );

  -- Issuing a replacement for one installation atomically rotates its token.
  update public.connector_credentials
    set revoked_at = clock_timestamp()
  where user_id = p_user_id
    and connector_instance_id = p_connector_instance_id
    and revoked_at is null;

  insert into public.connector_credentials (
    user_id, connector_instance_id, token_hash, expires_at
  ) values (
    p_user_id,
    p_connector_instance_id,
    decode(p_token_hash_hex, 'hex'),
    statement_timestamp() + make_interval(secs => p_ttl_seconds)
  );
  return true;
end;
$$;

create or replace function public.authenticate_connector_credential(
  p_token_hash_hex text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_credential public.connector_credentials%rowtype;
begin
  if p_token_hash_hex !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  select credential.* into v_credential
  from public.connector_credentials credential
  join public.user_accounts account on account.user_id = credential.user_id
  where credential.token_hash = decode(p_token_hash_hex, 'hex')
    and credential.revoked_at is null
    and credential.expires_at > statement_timestamp()
    and account.status = 'active'
  for update of credential;
  if not found then return null; end if;

  update public.connector_credentials
    set last_seen_at = clock_timestamp()
  where credential_id = v_credential.credential_id;

  return jsonb_build_object(
    'authenticatedUserId', v_credential.user_id::text,
    'connectorInstanceId', v_credential.connector_instance_id
  );
end;
$$;

create or replace function public.revoke_connector_credential(
  p_user_id uuid,
  p_connector_instance_id text
)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  with revoked as (
    update public.connector_credentials
      set revoked_at = clock_timestamp()
    where user_id = p_user_id
      and connector_instance_id = p_connector_instance_id
      and revoked_at is null
    returning 1
  )
  select exists(select 1 from revoked);
$$;

revoke all on function public.create_connector_credential(uuid, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.authenticate_connector_credential(text)
  from public, anon, authenticated;
revoke all on function public.revoke_connector_credential(uuid, text)
  from public, anon, authenticated;
grant execute on function public.create_connector_credential(uuid, text, text, integer)
  to service_role;
grant execute on function public.authenticate_connector_credential(text)
  to service_role;
grant execute on function public.revoke_connector_credential(uuid, text)
  to service_role;
