-- CLI-initiated, browser-approved connector authorization.
-- Only SHA-256 hashes of the device and user codes are durable. The device
-- secret and the resulting connector bearer are returned only to the CLI.

create table public.connector_device_authorizations (
  device_authorization_id uuid primary key default gen_random_uuid(),
  device_code_hash bytea not null unique check (octet_length(device_code_hash) = 32),
  user_code_hash bytea not null unique check (octet_length(user_code_hash) = 32),
  connector_instance_id text not null check (
    connector_instance_id ~ '^[A-Za-z0-9_-]{16,128}$'
  ),
  status text not null default 'pending' check (
    status in ('pending', 'approved', 'denied', 'expired', 'consumed')
  ),
  user_id uuid references public.user_accounts(user_id) on delete cascade,
  interval_seconds integer not null check (interval_seconds between 1 and 30),
  created_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > created_at),
  decided_at timestamptz,
  last_polled_at timestamptz,
  consumed_at timestamptz,
  check (status not in ('approved', 'denied', 'consumed') or user_id is not null)
);

create index connector_device_authorizations_expiry_idx
  on public.connector_device_authorizations (expires_at);
create index connector_device_authorizations_instance_rate_idx
  on public.connector_device_authorizations (connector_instance_id, created_at desc);

alter table public.connector_device_authorizations enable row level security;
revoke all on table public.connector_device_authorizations from public, anon, authenticated;
grant select, insert, update, delete on table public.connector_device_authorizations to service_role;

create or replace function public.create_connector_device_authorization(
  p_device_code_hash_hex text,
  p_user_code_hash_hex text,
  p_connector_instance_id text,
  p_created_at timestamptz,
  p_expires_at timestamptz,
  p_interval_seconds integer
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if p_device_code_hash_hex !~ '^[0-9a-f]{64}$'
     or p_user_code_hash_hex !~ '^[0-9a-f]{64}$'
     or p_connector_instance_id !~ '^[A-Za-z0-9_-]{16,128}$'
     or p_interval_seconds not between 1 and 30
     or p_expires_at <= p_created_at
     or p_expires_at > p_created_at + interval '15 minutes'
     or p_created_at < statement_timestamp() - interval '1 minute'
     or p_created_at > statement_timestamp() + interval '1 minute' then
    return false;
  end if;

  -- The endpoint is intentionally available before browser authentication, so
  -- bound durable limits protect the table even when callers rotate instance
  -- IDs. Expired rows are retained briefly for deterministic terminal replies.
  if (select count(*) from public.connector_device_authorizations
      where expires_at > p_created_at) >= 10000 then
    return false;
  end if;
  if (select count(*) from public.connector_device_authorizations
      where connector_instance_id = p_connector_instance_id
        and created_at > p_created_at - interval '1 minute') >= 5 then
    return false;
  end if;

  insert into public.connector_device_authorizations (
    device_code_hash,
    user_code_hash,
    connector_instance_id,
    interval_seconds,
    created_at,
    expires_at
  ) values (
    decode(p_device_code_hash_hex, 'hex'),
    decode(p_user_code_hash_hex, 'hex'),
    p_connector_instance_id,
    p_interval_seconds,
    p_created_at,
    p_expires_at
  );
  return true;
exception when unique_violation then
  return false;
end;
$$;

create or replace function public.load_connector_device_authorization(
  p_user_code_hash_hex text,
  p_now timestamptz
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_authorization public.connector_device_authorizations%rowtype;
begin
  if p_user_code_hash_hex !~ '^[0-9a-f]{64}$' then return null; end if;
  select device_auth.* into v_authorization
  from public.connector_device_authorizations device_auth
  where device_auth.user_code_hash = decode(p_user_code_hash_hex, 'hex')
  for update;
  if not found then return null; end if;

  if v_authorization.status in ('pending', 'approved') and v_authorization.expires_at <= p_now then
    update public.connector_device_authorizations
    set status = 'expired'
    where device_authorization_id = v_authorization.device_authorization_id;
    v_authorization.status := 'expired';
  end if;

  return jsonb_build_object(
    'connectorInstanceId', v_authorization.connector_instance_id,
    'status', v_authorization.status,
    'expiresAt', to_char(v_authorization.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$$;

create or replace function public.decide_connector_device_authorization(
  p_user_code_hash_hex text,
  p_user_id uuid,
  p_decision text,
  p_now timestamptz
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_authorization public.connector_device_authorizations%rowtype;
begin
  if p_user_code_hash_hex !~ '^[0-9a-f]{64}$'
     or p_decision not in ('approve', 'deny')
     or not exists (
       select 1 from public.user_accounts account
       where account.user_id = p_user_id and account.status = 'active'
     ) then
    return null;
  end if;

  select device_auth.* into v_authorization
  from public.connector_device_authorizations device_auth
  where device_auth.user_code_hash = decode(p_user_code_hash_hex, 'hex')
  for update;
  if not found then return null; end if;

  if v_authorization.status in ('pending', 'approved') and v_authorization.expires_at <= p_now then
    update public.connector_device_authorizations
    set status = 'expired'
    where device_authorization_id = v_authorization.device_authorization_id;
    v_authorization.status := 'expired';
  elsif v_authorization.status = 'pending' then
    update public.connector_device_authorizations
    set status = case when p_decision = 'approve' then 'approved' else 'denied' end,
        user_id = p_user_id,
        decided_at = p_now
    where device_authorization_id = v_authorization.device_authorization_id;
    v_authorization.status := case when p_decision = 'approve' then 'approved' else 'denied' end;
  end if;

  return jsonb_build_object(
    'connectorInstanceId', v_authorization.connector_instance_id,
    'status', v_authorization.status,
    'expiresAt', to_char(v_authorization.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$$;

create or replace function public.claim_connector_device_authorization(
  p_device_code_hash_hex text,
  p_now timestamptz
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_authorization public.connector_device_authorizations%rowtype;
begin
  if p_device_code_hash_hex !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('outcome', 'expired');
  end if;
  select device_auth.* into v_authorization
  from public.connector_device_authorizations device_auth
  where device_auth.device_code_hash = decode(p_device_code_hash_hex, 'hex')
  for update;
  if not found then return jsonb_build_object('outcome', 'expired'); end if;

  if v_authorization.status in ('pending', 'approved') and v_authorization.expires_at <= p_now then
    update public.connector_device_authorizations
    set status = 'expired'
    where device_authorization_id = v_authorization.device_authorization_id;
    return jsonb_build_object('outcome', 'expired');
  end if;

  if v_authorization.status = 'pending' then
    if v_authorization.last_polled_at is not null
       and p_now < v_authorization.last_polled_at + make_interval(secs => v_authorization.interval_seconds) then
      return jsonb_build_object('outcome', 'slow_down');
    end if;
    update public.connector_device_authorizations
    set last_polled_at = p_now
    where device_authorization_id = v_authorization.device_authorization_id;
    return jsonb_build_object('outcome', 'pending');
  end if;

  if v_authorization.status = 'approved' and v_authorization.user_id is not null then
    update public.connector_device_authorizations
    set status = 'consumed', consumed_at = p_now
    where device_authorization_id = v_authorization.device_authorization_id;
    return jsonb_build_object(
      'outcome', 'approved',
      'authenticatedUserId', v_authorization.user_id::text,
      'connectorInstanceId', v_authorization.connector_instance_id
    );
  end if;

  return jsonb_build_object('outcome', v_authorization.status);
end;
$$;

revoke all on function public.create_connector_device_authorization(text, text, text, timestamptz, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.load_connector_device_authorization(text, timestamptz) from public, anon, authenticated;
revoke all on function public.decide_connector_device_authorization(text, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.claim_connector_device_authorization(text, timestamptz) from public, anon, authenticated;
grant execute on function public.create_connector_device_authorization(text, text, text, timestamptz, timestamptz, integer) to service_role;
grant execute on function public.load_connector_device_authorization(text, timestamptz) to service_role;
grant execute on function public.decide_connector_device_authorization(text, uuid, text, timestamptz) to service_role;
grant execute on function public.claim_connector_device_authorization(text, timestamptz) to service_role;

-- Connector-authenticated equivalent of the browser project-id disconnect.
-- The control plane supplies both values from authenticated/safely collected
-- state; the database derives the project and reuses the canonical transaction.
create or replace function public.disconnect_user_repository_by_github_id(
  p_user_id uuid,
  p_github_repository_id bigint
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_project_id uuid;
begin
  select project.project_id into v_project_id
  from public.repository_projects project
  join public.project_memberships membership
    on membership.project_id = project.project_id
   and membership.user_id = p_user_id
  where project.github_repository_id = p_github_repository_id
    and project.status = 'active';
  if not found then return null; end if;
  return public.disconnect_user_repository(p_user_id, v_project_id);
end;
$$;

revoke all on function public.disconnect_user_repository_by_github_id(uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.disconnect_user_repository_by_github_id(uuid, bigint)
  to service_role;
