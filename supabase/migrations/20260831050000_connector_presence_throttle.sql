-- Keep connector authentication fail-closed on every request while bounding
-- write amplification from safe, non-secret presence telemetry.

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

  -- Authentication itself is never cached: revocation, expiry, and account
  -- status are checked on every request. Only the last-seen write is sampled.
  select credential.* into v_credential
  from public.connector_credentials credential
  join public.user_accounts account on account.user_id = credential.user_id
  where credential.token_hash = decode(p_token_hash_hex, 'hex')
    and credential.revoked_at is null
    and credential.expires_at > statement_timestamp()
    and account.status = 'active';
  if not found then return null; end if;

  update public.connector_credentials
    set last_seen_at = clock_timestamp()
  where credential_id = v_credential.credential_id
    and revoked_at is null
    and expires_at > statement_timestamp()
    and (
      last_seen_at is null or
      last_seen_at <= statement_timestamp() - interval '30 seconds'
    );

  return jsonb_build_object(
    'authenticatedUserId', v_credential.user_id::text,
    'connectorInstanceId', v_credential.connector_instance_id
  );
end;
$$;

-- CREATE OR REPLACE preserves the existing ACL. Repeat the intended grants
-- explicitly so a fresh or partially repaired environment still fails closed.
revoke all on function public.authenticate_connector_credential(text)
  from public, anon, authenticated;
grant execute on function public.authenticate_connector_credential(text)
  to service_role;
