-- Transactional contract/security tests for dedicated connector credentials.
begin;

do $$
declare
  v_user uuid := '10000000-0000-4000-8000-000000000001';
  v_instance text := 'connector_instance_0001';
  v_first_hash text := repeat('a', 64);
  v_second_hash text := repeat('b', 64);
  v_principal jsonb;
  v_first_seen timestamptz;
  v_throttled_seen timestamptz;
begin
  insert into public.user_accounts (user_id, status) values (v_user, 'active');

  if not public.create_connector_credential(
    v_user, v_instance, v_first_hash, 3600
  ) then
    raise exception 'T1 FAILED: active account could not create a connector credential';
  end if;
  v_principal := public.authenticate_connector_credential(v_first_hash);
  if v_principal <> jsonb_build_object(
    'authenticatedUserId', v_user::text,
    'connectorInstanceId', v_instance
  ) then
    raise exception 'T2 FAILED: credential did not resolve its bound principal %', v_principal;
  end if;
  if not exists (
    select 1 from public.connector_credentials credential
    where credential.user_id = v_user
      and credential.connector_instance_id = v_instance
      and credential.token_hash = decode(v_first_hash, 'hex')
      and credential.last_seen_at is not null
  ) then
    raise exception 'T2 FAILED: authentication did not update safe presence';
  end if;

  select credential.last_seen_at into v_first_seen
  from public.connector_credentials credential
  where credential.token_hash = decode(v_first_hash, 'hex');
  perform public.authenticate_connector_credential(v_first_hash);
  select credential.last_seen_at into v_throttled_seen
  from public.connector_credentials credential
  where credential.token_hash = decode(v_first_hash, 'hex');
  if v_throttled_seen is distinct from v_first_seen then
    raise exception 'T2 FAILED: presence was rewritten inside throttle window';
  end if;

  update public.connector_credentials
    set last_seen_at = statement_timestamp() - interval '31 seconds'
  where token_hash = decode(v_first_hash, 'hex');
  select credential.last_seen_at into v_first_seen
  from public.connector_credentials credential
  where credential.token_hash = decode(v_first_hash, 'hex');
  perform public.authenticate_connector_credential(v_first_hash);
  select credential.last_seen_at into v_throttled_seen
  from public.connector_credentials credential
  where credential.token_hash = decode(v_first_hash, 'hex');
  if v_throttled_seen <= v_first_seen then
    raise exception 'T2 FAILED: stale presence was not refreshed';
  end if;

  if not public.create_connector_credential(
    v_user, v_instance, v_second_hash, 3600
  ) then
    raise exception 'T3 FAILED: credential rotation failed';
  end if;
  if public.authenticate_connector_credential(v_first_hash) is not null then
    raise exception 'T3 FAILED: rotated credential remained active';
  end if;
  if public.authenticate_connector_credential(v_second_hash) is null then
    raise exception 'T3 FAILED: replacement credential was not active';
  end if;

  if not public.revoke_connector_credential(v_user, v_instance) then
    raise exception 'T4 FAILED: active credential was not revoked';
  end if;
  if public.authenticate_connector_credential(v_second_hash) is not null then
    raise exception 'T4 FAILED: revoked credential remained usable';
  end if;

  update public.user_accounts set status = 'disabled' where user_id = v_user;
  if public.create_connector_credential(
    v_user, v_instance, repeat('c', 64), 3600
  ) then
    raise exception 'T5 FAILED: disabled account created a connector credential';
  end if;

  if has_function_privilege(
    'anon', 'public.authenticate_connector_credential(text)', 'EXECUTE'
  ) or has_function_privilege(
    'authenticated', 'public.authenticate_connector_credential(text)', 'EXECUTE'
  ) then
    raise exception 'T6 FAILED: browser roles can authenticate connector credentials';
  end if;
end;
$$;

rollback;
