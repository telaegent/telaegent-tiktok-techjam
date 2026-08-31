import {
  SupabaseCapabilityGrantRepository,
  type SupabaseCapabilityGrantClient,
} from "../authorization/capability-grants.js";
import { CapabilityRouteAuthorizationService } from "../authorization/capability-route-authorization.js";
import {
  SupabaseCollaborationTaskRepository,
  type SupabaseCollaborationTaskClient,
} from "../authorization/collaboration-tasks.js";
import {
  SupabaseCapabilityRouteAuthorizationRepository,
  type SupabaseCapabilitySnapshotClient,
} from "../authorization/supabase-capability-repository.js";
import { DraftFollowUpService, type PrivateDraftFollowUp } from "./draft-follow-up.js";
import {
  CapabilityFollowUpCoordinator,
  type CapabilityResourceRelay,
} from "./follow-up-coordinator.js";
import type { CapabilityScopeExpansionService } from "./service.js";

/**
 * Composition for the capability loop (build plan 8).
 *
 * Everything here is already reachable on its own; what was missing was the
 * assembly. Without it a recipient agent could ask for a file and nothing
 * would carry the question anywhere, so the loop existed in the code and not
 * in the product.
 *
 * The three seams stay separate on purpose. Routing is authorized against the
 * record, the batch goes out over the connector relay, and the human gate is
 * the scope service - no part of this decides on its own that a file may be
 * read.
 */

/** Matches the deadline the private-runtime authorization path already uses. */
const repositoryReadTimeoutMs = 5_000;

export interface CapabilityFollowUpCompositionDependencies {
  /**
   * The service-role client for the authorization schema. One client backs the
   * snapshot read, the grant ledger and the task record because they are the
   * same trust boundary.
   */
  authorization: SupabaseCapabilitySnapshotClient &
    SupabaseCapabilityGrantClient &
    SupabaseCollaborationTaskClient;
  /** The cloud-to-local transport; the only way a request reaches a machine. */
  relay: CapabilityResourceRelay;
  /** The human gate: where a file nobody has approved becomes a question. */
  scope: CapabilityScopeExpansionService;
}

export function createPrivateDraftFollowUp(
  dependencies: Readonly<CapabilityFollowUpCompositionDependencies>,
): PrivateDraftFollowUp {
  return new DraftFollowUpService({
    tasks: new SupabaseCollaborationTaskRepository(dependencies.authorization),
    coordinator: new CapabilityFollowUpCoordinator({
      scope: dependencies.scope,
      authorization: new CapabilityRouteAuthorizationService(
        new SupabaseCapabilityRouteAuthorizationRepository(
          dependencies.authorization,
        ),
        { repositoryReadTimeoutMs },
      ),
      relay: dependencies.relay,
      grants: new SupabaseCapabilityGrantRepository(dependencies.authorization),
    }),
  });
}
