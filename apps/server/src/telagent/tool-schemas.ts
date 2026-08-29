/**
 * TOOL ARGUMENT SCHEMAS — Duy's, keyed by tool name.
 *
 * This file used to *declare* provisional schemas so workstream #6 could build
 * on Day 1. Duy's `schemas.ts` has landed, so it now does nothing but map his
 * schemas to the tool names the dispatcher switches on. The dispatcher re-parses
 * with these even though the permission engine already parsed — cheap, and it
 * means a bug upstream cannot turn into a filesystem operation.
 */

import {
  askStatusInputSchema,
  completeTaskInputSchema,
  createContextPackInputSchema,
  proposeReplanInputSchema,
  publishIntentInputSchema,
  relayReplyInputSchema,
  reportDependencyChangeInputSchema,
  requestContextInputSchema,
  requestHumanDecisionInputSchema,
  suggestResolutionInputSchema,
  updateProgressInputSchema,
} from "./schemas.js";

export const TOOL_ARGUMENT_SCHEMAS = {
  relay_publish_intent: publishIntentInputSchema,
  relay_update_progress: updateProgressInputSchema,
  relay_ask_status: askStatusInputSchema,
  relay_reply: relayReplyInputSchema,
  relay_suggest_resolution: suggestResolutionInputSchema,
  relay_request_context: requestContextInputSchema,
  relay_create_context_pack: createContextPackInputSchema,
  relay_report_dependency_change: reportDependencyChangeInputSchema,
  relay_propose_replan: proposeReplanInputSchema,
  relay_complete_task: completeTaskInputSchema,
  relay_request_human_decision: requestHumanDecisionInputSchema,
} as const;

export type ToolArgumentSchemas = typeof TOOL_ARGUMENT_SCHEMAS;
