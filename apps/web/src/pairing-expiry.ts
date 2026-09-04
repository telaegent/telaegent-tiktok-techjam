export const CONNECTOR_PAIRING_POLL_INTERVAL_MS = 1_500;
export const CONNECTOR_PAIRING_STATUS_GRACE_MS = 15_000;
export const CONNECTOR_SETUP_POLL_WINDOW_MS = 5 * 60_000;
export const CONNECTOR_SETUP_MAX_POLL_INTERVAL_MS = 15_000;

export type ConnectorCredentialLease = Readonly<{
  status: "active" | "expired" | "revoked";
  expiresAt: string;
}>;

export type ConnectorSetupSnapshot = Readonly<{
  liveReady: boolean;
  credential: ConnectorCredentialLease | null;
  bindings: readonly Readonly<{
    bindingStatus:
      | "provisioning"
      | "ready"
      | "stopped"
      | "unavailable"
      | "revoked";
    membershipStatus: "active" | "suspended" | "revoked";
    repositoryAccessStatus: "verified" | "revalidation_required" | "revoked";
  }>[];
}>;

export type ConnectorSetupPhase =
  | "not_exchanged"
  | "verifying"
  | "ready"
  | "credential_inactive";

export type ConnectorSetupPollOutcome =
  | Readonly<{
      kind: "wait";
      delayMs: number;
      credentialObserved: boolean;
    }>
  | Readonly<{
      kind: "stop";
      reason: "pairing_expired" | "credential_inactive" | "setup_timed_out";
    }>
  | Readonly<{ kind: "ready" }>;

/** Returns null once a pairing is unusable; otherwise the next bounded delay. */
export function nextPairingPollDelay(
  expiresAt: string,
  nowMs = Date.now(),
): number | null {
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) return null;
  return Math.min(CONNECTOR_PAIRING_POLL_INTERVAL_MS, expiresMs - nowMs);
}

/** Maps the browser-safe status across pairing, credential, and ready states. */
export function connectorSetupPhase(
  connector: ConnectorSetupSnapshot,
): ConnectorSetupPhase {
  if (
    connector.credential !== null &&
    connector.credential.status !== "active"
  ) {
    return "credential_inactive";
  }
  if (
    connector.liveReady &&
    connector.credential?.status === "active" &&
    connector.bindings.some(
      (binding) =>
        binding.bindingStatus === "ready" &&
        binding.membershipStatus === "active" &&
        binding.repositoryAccessStatus === "verified",
    )
  ) {
    return "ready";
  }
  if (connector.credential?.status === "active") return "verifying";
  return "not_exchanged";
}

/**
 * Tracks the bootstrap-to-credential handoff for one connector command.
 *
 * A short grace period closes the race between consuming the one-time code and
 * making its credential visible through setup status. Once an active
 * credential is observed, automatic polling backs off and ends after a
 * separate setup window; the long-lived credential lifetime is not a polling
 * deadline.
 */
export class ConnectorSetupPollTracker {
  private credential: ConnectorCredentialLease | null = null;
  private credentialObservedAtMs: number | null = null;
  private activeCredentialPolls = 0;

  constructor(private readonly pairingExpiresAt: string) {}

  async check(
    loadStatus: () => Promise<ConnectorSetupSnapshot>,
    now: () => number = Date.now,
  ): Promise<ConnectorSetupPollOutcome> {
    try {
      const connector = await loadStatus();
      const checkedAtMs = now();
      const phase = connectorSetupPhase(connector);
      if (phase === "ready") return { kind: "ready" };
      if (phase === "credential_inactive") {
        return { kind: "stop", reason: "credential_inactive" };
      }
      // Do not let a transient or eventually-consistent null erase proof that
      // the pairing already crossed into its durable credential lifecycle.
      if (connector.credential !== null) {
        if (this.credential?.status !== "active") {
          this.credentialObservedAtMs = checkedAtMs;
          this.activeCredentialPolls = 0;
        }
        this.credential = connector.credential;
      }
    } catch {
      // Before exchange there may be no durable row. After exchange, retain the
      // last active credential across transient status failures.
    }

    const decision = this.nextDecision(now());
    if (decision.kind === "wait" && this.credential?.status === "active") {
      this.activeCredentialPolls += 1;
    }
    return decision;
  }

  private nextDecision(nowMs: number): ConnectorSetupPollOutcome {
    if (this.credential === null) {
      const pairingExpiresMs = Date.parse(this.pairingExpiresAt);
      const recoveryDeadlineMs =
        pairingExpiresMs + CONNECTOR_PAIRING_STATUS_GRACE_MS;
      if (!Number.isFinite(recoveryDeadlineMs) || recoveryDeadlineMs <= nowMs) {
        return { kind: "stop", reason: "pairing_expired" };
      }
      return {
        kind: "wait",
        delayMs: Math.min(
          CONNECTOR_PAIRING_POLL_INTERVAL_MS,
          recoveryDeadlineMs - nowMs,
        ),
        credentialObserved: false,
      };
    }

    if (this.credential.status !== "active") {
      return { kind: "stop", reason: "credential_inactive" };
    }
    const credentialExpiresMs = Date.parse(this.credential.expiresAt);
    if (!Number.isFinite(credentialExpiresMs) || credentialExpiresMs <= nowMs) {
      return { kind: "stop", reason: "credential_inactive" };
    }
    const setupDeadlineMs =
      (this.credentialObservedAtMs ?? nowMs) + CONNECTOR_SETUP_POLL_WINDOW_MS;
    if (setupDeadlineMs <= nowMs) {
      return { kind: "stop", reason: "setup_timed_out" };
    }
    const backoffMs = Math.min(
      CONNECTOR_SETUP_MAX_POLL_INTERVAL_MS,
      CONNECTOR_PAIRING_POLL_INTERVAL_MS *
        2 ** Math.min(this.activeCredentialPolls, 4),
    );
    return {
      kind: "wait",
      delayMs: Math.min(
        backoffMs,
        credentialExpiresMs - nowMs,
        setupDeadlineMs - nowMs,
      ),
      credentialObserved: true,
    };
  }
}
