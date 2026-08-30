begin;

do $$
declare
  v_state_hash text := repeat('a', 64);
  v_session_hash text := repeat('b', 64);
  v_second_session_hash text := repeat('c', 64);
  v_return_to text;
  v_user jsonb;
  v_same_user jsonb;
  v_loaded jsonb;
begin
  perform public.create_github_oauth_state(
    v_state_hash,
    '/?view=platform'
  );
  v_return_to := public.consume_github_oauth_state(v_state_hash);
  if v_return_to is distinct from '/?view=platform' then
    raise exception 'OAuth return path did not round-trip';
  end if;
  if public.consume_github_oauth_state(v_state_hash) is not null then
    raise exception 'OAuth state was not single-use';
  end if;

  v_user := public.complete_github_oauth_login(
    9223372036854770000,
    'khoa-dao',
    'https://avatars.githubusercontent.com/u/1',
    v_session_hash,
    1209600
  );
  if v_user->>'githubUserId' is distinct from '9223372036854770000' then
    raise exception 'GitHub user ID lost precision';
  end if;

  v_loaded := public.load_telaegent_web_session(v_session_hash);
  if v_loaded->>'userId' is distinct from v_user->>'userId' then
    raise exception 'Active Telaegent session did not resolve its account';
  end if;

  if exists (
    select 1 from public.github_connections
    where user_id = (v_user->>'userId')::uuid
  ) then
    raise exception 'Website OAuth incorrectly created a local GitHub connection';
  end if;

  v_same_user := public.complete_github_oauth_login(
    9223372036854770000,
    'khoa-dao-renamed',
    null,
    v_second_session_hash,
    1209600
  );
  if v_same_user->>'userId' is distinct from v_user->>'userId' then
    raise exception 'Stable GitHub identity created a second Telaegent account';
  end if;

  if not public.revoke_telaegent_web_session(v_session_hash) then
    raise exception 'Active session was not revoked';
  end if;
  if public.load_telaegent_web_session(v_session_hash) is not null then
    raise exception 'Revoked session remained usable';
  end if;

  update public.user_accounts
    set status = 'disabled'
  where user_id = (v_user->>'userId')::uuid;
  if public.load_telaegent_web_session(v_second_session_hash) is not null then
    raise exception 'Disabled account retained an active session';
  end if;
  if public.complete_github_oauth_login(
    9223372036854770000,
    'khoa-dao-renamed',
    null,
    repeat('d', 64),
    1209600
  ) is not null then
    raise exception 'Disabled account created a new session';
  end if;
end;
$$;

rollback;
