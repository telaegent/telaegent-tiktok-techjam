import type {
  AuthorizeCapabilityRouteInput,
  CapabilityRouteAuthorizationSnapshot,
} from "./capability-types.js";

export interface CapabilityRouteAuthorizationReadOptions {
  signal?: AbortSignal | undefined;
}

/**
 * Loads safe grant-routing facts in one logical snapshot. Implementations must
 * never return canonical paths, contents, credentials, or local policy state.
 */
export interface CapabilityRouteAuthorizationRepository {
  loadCapabilityRouteAuthorizationSnapshot(
    input: Readonly<AuthorizeCapabilityRouteInput>,
    options?: Readonly<CapabilityRouteAuthorizationReadOptions>,
  ): Promise<CapabilityRouteAuthorizationSnapshot>;
}
