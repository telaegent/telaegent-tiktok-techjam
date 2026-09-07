-- Transactional contract, abuse-bound, retry, cleanup, and ACL tests for
-- CLI-initiated browser authorization.
begin;

do $$
declare
  v_user uuid := 'a1000000-0000-4000-8000-000000000001';
  v_now timestamptz := statement_timestamp();
  v_result jsonb;
begin
  insert into public.user_accounts (user_id, status) values (v_user, 'active');

  if not public.create_connector_device_authorization(
    repeat('a', 64), repeat('b', 64), repeat('e', 64),
    'connector_device_test_01', v_now, v_now + interval '5 minutes', 3
  ) then
    raise exception 'T1 FAILED: device authorization was not created';
  end if;
  if exists (
    select 1 from public.connector_device_authorizations
    where device_code_hash = convert_to(repeat('a', 64), 'UTF8')
       or user_code_hash = convert_to(repeat('b', 64), 'UTF8')
       or credential_token_hash = convert_to(repeat('e', 64), 'UTF8')
  ) then
    raise exception 'T1 FAILED: a raw public code or credential was stored';
  end if;

  v_result := public.load_connector_device_authorization(repeat('b', 64), v_now);
  if v_result #>> '{status}' <> 'pending'
     or v_result #>> '{connectorInstanceId}' <> 'connector_device_test_01' then
    raise exception 'T2 FAILED: pending request was not inspectable %', v_result;
  end if;

  v_result := public.redeem_connector_device_authorization(repeat('a', 64), v_now, 3600);
  if v_result #>> '{outcome}' <> 'pending' then
    raise exception 'T3 FAILED: unapproved request issued authority %', v_result;
  end if;
  v_result := public.decide_connector_device_authorization(
    repeat('b', 64), v_user, 'approve', v_now + interval '1 second'
  );
  if v_result #>> '{status}' <> 'approved' then
    raise exception 'T4 FAILED: browser approval did not persist %', v_result;
  end if;
  v_result := public.redeem_connector_device_authorization(
    repeat('a', 64), v_now + interval '3 seconds', 3600
  );
  if v_result #>> '{outcome}' <> 'approved'
     or v_result #>> '{connectorInstanceId}' <> 'connector_device_test_01' then
    raise exception 'T5 FAILED: approved request could not activate its credential %', v_result;
  end if;
  if not exists (
    select 1 from public.connector_credentials
    where user_id = v_user
      and connector_instance_id = 'connector_device_test_01'
      and token_hash = decode(repeat('e', 64), 'hex')
      and revoked_at is null
  ) then
    raise exception 'T5 FAILED: approved credential hash was not activated';
  end if;

  -- Losing the first HTTP response is safe: the raw bearer remains only in the
  -- CLI and a repeated redemption confirms the same active hash without rotation.
  v_result := public.redeem_connector_device_authorization(
    repeat('a', 64), v_now + interval '4 seconds', 3600
  );
  if v_result #>> '{outcome}' <> 'approved'
     or (select count(*) from public.connector_credentials
         where user_id = v_user
           and connector_instance_id = 'connector_device_test_01') <> 1 then
    raise exception 'T6 FAILED: redemption retry was not idempotent %', v_result;
  end if;
  v_result := public.redeem_connector_device_authorization(
    repeat('a', 64), v_now + interval '5 minutes 30 seconds', 3600
  );
  if v_result #>> '{outcome}' <> 'approved'
     or (select count(*) from public.connector_credentials
         where user_id = v_user
           and connector_instance_id = 'connector_device_test_01') <> 1 then
    raise exception 'T6 FAILED: consumed retry was not recoverable after expiry %', v_result;
  end if;
  v_result := public.redeem_connector_device_authorization(
    repeat('a', 64), v_now + interval '6 minutes 1 second', 3600
  );
  if v_result #>> '{outcome}' <> 'consumed' then
    raise exception 'T6 FAILED: consumed recovery grace was not bounded %', v_result;
  end if;

  if not public.create_connector_device_authorization(
    repeat('c', 64), repeat('d', 64), repeat('f', 64),
    'connector_device_test_02', v_now, v_now + interval '1 minute', 3
  ) then
    raise exception 'T7 FAILED: expiry fixture was not created';
  end if;
  perform public.decide_connector_device_authorization(
    repeat('d', 64), v_user, 'approve', v_now + interval '1 second'
  );
  if public.redeem_connector_device_authorization(
    repeat('c', 64), v_now + interval '2 minutes', 3600
  ) #>> '{outcome}' <> 'expired' then
    raise exception 'T7 FAILED: approved authorization survived expiry';
  end if;

  insert into public.connector_device_authorizations (
    device_code_hash, user_code_hash, credential_token_hash,
    connector_instance_id, status, interval_seconds, created_at, expires_at
  ) values (
    decode(repeat('0', 64), 'hex'), decode(repeat('1', 64), 'hex'),
    decode(repeat('2', 64), 'hex'), 'connector_cleanup_test', 'expired', 3,
    v_now - interval '30 minutes', v_now - interval '20 minutes'
  );
  if not public.create_connector_device_authorization(
    repeat('3', 64), repeat('4', 64), repeat('5', 64),
    'connector_cleanup_new', v_now, v_now + interval '5 minutes', 3
  ) then
    raise exception 'T8 FAILED: cleanup-triggering authorization was not created';
  end if;
  -- Keep this check in a separate statement. PostgreSQL does not guarantee
  -- left-to-right evaluation of Boolean subexpressions with side effects.
  if exists (
    select 1 from public.connector_device_authorizations
    where connector_instance_id = 'connector_cleanup_test'
  ) then
    raise exception 'T8 FAILED: bounded stale-row cleanup did not run';
  end if;

  if position(
    'pg_advisory_xact_lock' in pg_get_functiondef(
      'public.create_connector_device_authorization(text,text,text,text,timestamptz,timestamptz,integer)'::regprocedure
    )
  ) = 0 then
    raise exception 'T9 FAILED: creation limits are not transactionally serialized';
  end if;

  insert into public.connector_device_authorizations (
    device_code_hash, user_code_hash, credential_token_hash,
    connector_instance_id, status, interval_seconds, created_at, expires_at
  )
  select
    decode(lpad(to_hex(1000 + fixture), 64, '0'), 'hex'),
    decode(lpad(to_hex(2000 + fixture), 64, '0'), 'hex'),
    decode(lpad(to_hex(3000 + fixture), 64, '0'), 'hex'),
    'rotating_instance_' || fixture::text,
    'pending', 3, v_now, v_now + interval '5 minutes'
  from generate_series(1, 300) fixture;
  if public.create_connector_device_authorization(
    repeat('6', 64), repeat('7', 64), repeat('8', 64),
    'connector_global_rate', v_now, v_now + interval '5 minutes', 3
  ) then
    raise exception 'T10 FAILED: rotating IDs bypassed the global rolling limit';
  end if;
end;
$$;

do $$
begin
  if has_function_privilege(
       'anon',
       'public.create_connector_device_authorization(text,text,text,text,timestamptz,timestamptz,integer)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.redeem_connector_device_authorization(text,timestamptz,integer)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.decide_connector_device_authorization(text,uuid,text,timestamptz)',
       'EXECUTE'
     ) then
    raise exception 'T11 FAILED: device authorization RPC ACL is unsafe';
  end if;
end;
$$;

rollback;
