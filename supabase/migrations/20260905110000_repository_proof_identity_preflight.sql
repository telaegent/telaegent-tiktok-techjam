-- Cheap, side-effect-free admission gate for public repository verification.
--
-- The connector route has already authenticated both values in the principal.
-- This RPC binds the claimed GitHub numeric identity to that authenticated
-- account before the server spends any of GitHub's shared anonymous quota.

create or replace function public.authorize_local_github_proof_identity(
  p_user_id              uuid,
  p_connector_instance_id text,
  p_github_user_id       bigint
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_account_status text;
  v_identity_github_user_id bigint;
begin
  if p_user_id is null or
     p_connector_instance_id is null or
     p_connector_instance_id !~ '^[A-Za-z0-9_-]{16,128}$' or
     p_github_user_id is null or p_github_user_id <= 0 then
    return jsonb_build_object('error', 'github_identity_mismatch');
  end if;

  select account.status, identity.github_user_id
    into v_account_status, v_identity_github_user_id
  from public.user_accounts account
  join public.account_github_identities identity
    on identity.user_id = account.user_id
  where account.user_id = p_user_id;

  if v_account_status is distinct from 'active' then
    return jsonb_build_object('error', 'account_inactive');
  end if;
  if v_identity_github_user_id is distinct from p_github_user_id then
    return jsonb_build_object('error', 'github_identity_mismatch');
  end if;
  if exists (
    select 1
    from public.github_connections connection
    where connection.github_user_id = p_github_user_id
      and connection.user_id <> p_user_id
  ) then
    return jsonb_build_object('error', 'github_identity_mismatch');
  end if;

  return jsonb_build_object('outcome', 'authorized');
end;
$$;

revoke all on function public.authorize_local_github_proof_identity(uuid, text, bigint)
  from public, anon, authenticated;
grant execute on function public.authorize_local_github_proof_identity(uuid, text, bigint)
  to service_role;
