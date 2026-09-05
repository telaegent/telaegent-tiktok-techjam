-- Recovering private drafts that a restart left running.
--
-- Draft state is durable; the runtime that advances it is not. The turn
-- coordinator's tracking, the connector job relay's registrations and the
-- in-flight completion promise all live in process memory, so a backend
-- restart loses every one of them while `agent_working` rows survive.
--
-- Such a draft is unrecoverable through the normal API. It cannot run again,
-- because `run_private_draft` requires state `created`. It cannot be cancelled,
-- because cancelling a running draft has to name the turn the coordinator
-- believes is running and no coordinator has that turn any more. The owner is
-- left with a draft that shows an agent working on it forever.
--
-- Reconciliation moves those rows into the same terminal state a lost runtime
-- would have produced, with a retryable failure so the owner can simply run the
-- draft again.
--
-- SINGLE WRITER. This fails every `agent_working` draft, not only the ones this
-- process started, because a restarted process cannot tell them apart -- the
-- turn identifiers it would need died with the previous process. That is
-- correct for the single control-plane container this deployment runs and
-- WRONG the moment a second replica starts, where it would fail drafts another
-- live instance is still working on. Before scaling horizontally, give drafts
-- an owning-instance column and scope this to the instance that is starting.
create or replace function public.reconcile_running_private_drafts(
  p_private_message text,
  p_failure         jsonb,
  p_updated_at      timestamptz
)
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  with reconciled as (
    update public.private_drafts as d
    set state = 'runtime_failed',
        private_message = p_private_message,
        failure = p_failure,
        -- A candidate produced by a turn that never finished was never
        -- approved and must not survive into the next run.
        send_candidate = null,
        updated_at = p_updated_at
    where d.state = 'agent_working'
    returning 1
  )
  select count(*)::integer from reconciled;
$$;

revoke all on function public.reconcile_running_private_drafts(text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.reconcile_running_private_drafts(text, jsonb, timestamptz)
  to service_role;
