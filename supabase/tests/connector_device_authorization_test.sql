-- Transactional contract and ACL tests for CLI-initiated browser authorization.
begin;

do $$
declare
  v_user uuid := 'a1000000-0000-4000-8000-000000000001';
  v_now timestamptz := statement_timestamp();
  v_result jsonb;
begin
  insert into public.user_accounts (user_id, status) values (v_user, 'active');

  if not public.create_connector_device_authorization(
    repeat('a', 64), repeat('b', 64), 'connector_device_test_01',
    v_now, v_now + interval '5 minutes', 3
  ) then
    raise exception 'T1 FAILED: device authorization was not created';
  end if;
  if exists (
    select 1 from public.connector_device_authorizations
    where device_code_hash = convert_to(repeat('a', 64), 'UTF8')
       or user_code_hash = convert_to(repeat('b', 64), 'UTF8')
  ) then
    raise exception 'T1 FAILED: a raw public code was stored';
  end if;

  v_result := public.load_connector_device_authorization(repeat('b', 64), v_now);
  if v_result #>> '{status}' <> 'pending'
     or v_result #>> '{connectorInstanceId}' <> 'connector_device_test_01' then
    raise exception 'T2 FAILED: pending request was not inspectable %', v_result;
  end if;

  v_result := public.claim_connector_device_authorization(repeat('a', 64), v_now);
  if v_result #>> '{outcome}' <> 'pending' then
    raise exception 'T3 FAILED: unapproved request issued authority %', v_result;
  end if;
  v_result := public.decide_connector_device_authorization(
    repeat('b', 64), v_user, 'approve', v_now + interval '1 second'
  );
  if v_result #>> '{status}' <> 'approved' then
    raise exception 'T4 FAILED: browser approval did not persist %', v_result;
  end if;
  v_result := public.claim_connector_device_authorization(
    repeat('a', 64), v_now + interval '3 seconds'
  );
  if v_result #>> '{outcome}' <> 'approved'
     or v_result #>> '{authenticatedUserId}' <> v_user::text then
    raise exception 'T5 FAILED: approved request could not be claimed %', v_result;
  end if;
  if public.claim_connector_device_authorization(
    repeat('a', 64), v_now + interval '4 seconds'
  ) #>> '{outcome}' <> 'consumed' then
    raise exception 'T5 FAILED: device code replay was not terminal';
  end if;

  if not public.create_connector_device_authorization(
    repeat('c', 64), repeat('d', 64), 'connector_device_test_02',
    v_now, v_now + interval '1 minute', 3
  ) then
    raise exception 'T6 FAILED: expiry fixture was not created';
  end if;
  perform public.decide_connector_device_authorization(
    repeat('d', 64), v_user, 'approve', v_now + interval '1 second'
  );
  if public.claim_connector_device_authorization(
    repeat('c', 64), v_now + interval '2 minutes'
  ) #>> '{outcome}' <> 'expired' then
    raise exception 'T6 FAILED: approved authorization survived expiry';
  end if;
end;
$$;

do $$
begin
  if has_function_privilege('anon', 'public.create_connector_device_authorization(text,text,text,timestamptz,timestamptz,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.claim_connector_device_authorization(text,timestamptz)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.decide_connector_device_authorization(text,uuid,text,timestamptz)', 'EXECUTE') then
    raise exception 'T7 FAILED: device authorization RPC ACL is unsafe';
  end if;
end;
$$;

rollback;
