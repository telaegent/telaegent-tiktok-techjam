/**
 * DEPENDENCY IMPACT — which active intents does a published contract change
 * actually break?
 *
 * Exact membership on normalized identifiers. Never fuzzy, never a model
 * judgement: `plan.md` §14 is explicit that the model may explain a change but
 * may not decide whether it matters.
 *
 * FINDING C11: identifier normalization lives HERE and is exported for Duy's
 * conflict engine to import, so the conflict that fires at stage 3 and the
 * impact that fires at stage 12 can never disagree about what "Session" means.
 * If Duy's engine lands first, this file re-exports his instead.
 */

import type {
  ActiveAgreement,
  DependencyChangeView,
  DenialCode,
  ImpactIntentView,
} from "./contract.js";
import { normalizeSourcePath, type PolicyResult } from "./context-policy.js";

/* ========================================================================== *
 * Identifier normalization — the single shared definition
 * ========================================================================== */

/**
 * `SessionRepository.create` and `sessionrepository` both normalize to
 * `sessionrepository`; `POST /login` normalizes to `post /login`.
 *
 * Member access is stripped so a change to `SessionRepository.create` matches
 * an intent that declares a dependency on `SessionRepository`.
 */
export function normalizeInterfaceName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\(\s*\)$/, "")
    .trim();
}

/** The identifier plus every prefix a declaration could reasonably name. */
export function interfaceMatchKeys(input: string): string[] {
  const normalized = normalizeInterfaceName(input);
  if (normalized.length === 0) return [];
  const keys = new Set<string>([normalized]);
  const dot = normalized.indexOf(".");
  if (dot > 0) keys.add(normalized.slice(0, dot));
  const hash = normalized.indexOf("#");
  if (hash > 0) keys.add(normalized.slice(0, hash));
  return [...keys];
}

function declaredKeys(intent: ImpactIntentView): Set<string> {
  const keys = new Set<string>();
  for (const declaration of [...intent.interfaces, ...intent.dependencies]) {
    for (const key of interfaceMatchKeys(declaration)) keys.add(key);
  }
  return keys;
}

/* ========================================================================== *
 * Impact
 * ========================================================================== */

export interface ImpactedIntent {
  intentId: string;
  ownerId: string;
  agentId: string;
  /** Why it matched, for the UI and the audit event. */
  matchedOn: string[];
  /** True when the active agreement also links these two owners explicitly. */
  agreementLinked: boolean;
}

export interface DependencyImpact {
  dependencyChangeId: string;
  interfaceName: string;
  sourcePath: string;
  commit: string;
  impacted: ImpactedIntent[];
  unaffectedIntentIds: string[];
  /** True when the agreement required this change to be published, and it was. */
  publicationRequired: boolean;
}

export interface DetectImpactInput {
  change: DependencyChangeView;
  /** Duy's full `Intent` records are structurally assignable to this view. */
  activeIntents: readonly ImpactIntentView[];
  agreement?: ActiveAgreement | undefined;
}

const fail = (code: DenialCode, safeReason: string, input = ""): PolicyResult<never> => ({
  ok: false,
  code,
  safeReason,
  input,
});

/**
 * Validates the change, then partitions active intents into impacted and
 * unaffected. Returns safe evidence for Khoa to turn into a PlanRevision.
 */
export function detectDependencyImpact(
  input: DetectImpactInput,
): PolicyResult<DependencyImpact> {
  const { change, activeIntents, agreement } = input;

  // 1. The source path is validated like any other path — a dependency change
  //    is model output too.
  const sourcePath = normalizeSourcePath(change.sourcePath);
  if (!sourcePath.ok) return sourcePath;

  if (!/^[0-9a-f]{7,40}$/i.test(change.commit)) {
    return fail("PACK_STALE_SOURCE", "The change does not cite a valid commit.", change.commit);
  }

  // The publication names its primary interface plus any related identifiers.
  // Matching stays exact membership — the free-text `change` description is
  // never consulted (plan.md §14: the model may explain, not decide).
  const changedKeys = [
    ...new Set(
      [change.interface, ...(change.relatedInterfaces ?? [])].flatMap(
        interfaceMatchKeys,
      ),
    ),
  ];
  if (changedKeys.length === 0) {
    return fail("PACK_SCOPE_MISMATCH", "The change does not name an interface.");
  }
  if (changedKeys.length > 20) {
    return fail("PACK_SCOPE_MISMATCH", "The change names too many interfaces.");
  }

  // 2. Exact membership against each intent's declared interfaces and
  //    dependencies. The publisher's own intent is never "impacted" by itself.
  const impacted: ImpactedIntent[] = [];
  const unaffectedIntentIds: string[] = [];

  for (const intent of activeIntents) {
    if (intent.intentId === change.intentId || intent.agentId === change.agentId) {
      continue;
    }
    const keys = declaredKeys(intent);
    const matchedOn = changedKeys.filter((key) => keys.has(key));
    const agreementLinked = isLinkedByAgreement(agreement, intent, change, changedKeys);

    // Two deterministic ways to be impacted: the intent declared the identifier
    // itself, or a human-approved agreement links this intent to it. The second
    // is not fuzzy — it is a record two owners signed.
    if (matchedOn.length === 0 && !agreementLinked) {
      unaffectedIntentIds.push(intent.intentId);
      continue;
    }
    impacted.push({
      intentId: intent.intentId,
      ownerId: intent.ownerId,
      agentId: intent.agentId,
      matchedOn: matchedOn.length > 0 ? matchedOn.sort() : ["agreement:dependency_link"],
      agreementLinked,
    });
  }

  return {
    ok: true,
    value: {
      dependencyChangeId: change.dependencyChangeId,
      interfaceName: change.interface,
      sourcePath: sourcePath.value,
      commit: change.commit,
      impacted: impacted.sort((left, right) => left.intentId.localeCompare(right.intentId)),
      unaffectedIntentIds: unaffectedIntentIds.sort(),
      publicationRequired: requiresPublication(agreement, changedKeys),
    },
  };
}

function isLinkedByAgreement(
  agreement: ActiveAgreement | undefined,
  intent: ImpactIntentView,
  change: DependencyChangeView,
  changedKeys: readonly string[],
): boolean {
  if (!agreement || agreement.state !== "active") return false;
  return agreement.dependencyLinks.some(
    (link) =>
      link.consumerIntentId === intent.intentId &&
      link.providerIntentId === change.intentId &&
      interfaceMatchKeys(link.interface).some((key) => changedKeys.includes(key)),
  );
}

function requiresPublication(
  agreement: ActiveAgreement | undefined,
  changedKeys: readonly string[],
): boolean {
  if (!agreement || agreement.state !== "active") return false;
  return agreement.dependencyLinks.some((link) =>
    interfaceMatchKeys(link.interface).some((key) => changedKeys.includes(key)),
  );
}

/* ========================================================================== *
 * Plan revision validation
 * ========================================================================== */

export interface PlanRevisionCandidate {
  originalPlan: string[];
  revisedPlan: string[];
  affectedFiles: string[];
}

/**
 * A revised plan may not quietly take ownership of files the agreement gave to
 * someone else. This is the check behind "replanning preserves the approved
 * ownership agreement" (TELAEGENT_PRODUCT_FLOW, essential verification).
 */
export function validatePlanRevision(
  candidate: PlanRevisionCandidate,
  agreement: ActiveAgreement,
  affectedOwnerId: string,
): PolicyResult<{ affectedFiles: string[] }> {
  if (candidate.revisedPlan.length === 0) {
    return fail("PACK_SCOPE_MISMATCH", "The revision contains no steps.");
  }
  if (candidate.revisedPlan.length > 12) {
    return fail("PACK_SCOPE_MISMATCH", "The revision exceeds twelve steps.");
  }

  const owned = agreement.ownership.find((rule) => rule.ownerId === affectedOwnerId);
  if (!owned) {
    return fail("OWNERSHIP_VIOLATION", "The agreement assigns this owner no files.");
  }

  const normalizedFiles: string[] = [];
  for (const file of candidate.affectedFiles) {
    const normalized = normalizeSourcePath(file);
    if (!normalized.ok) return normalized;
    normalizedFiles.push(normalized.value);
  }

  const foreign = normalizedFiles.filter(
    (file) => !ownedByRule(file, owned.files),
  );
  if (foreign.length > 0) {
    return fail(
      "OWNERSHIP_VIOLATION",
      "The revised plan claims " + foreign.length + " file(s) owned by another Agent.",
      foreign.sort().join(", "),
    );
  }

  return { ok: true, value: { affectedFiles: normalizedFiles.sort() } };
}

function ownedByRule(candidate: string, paths: readonly string[]): boolean {
  return paths.some((rule) => {
    const normalizedRule = rule.replace(/\\/g, "/").replace(/^\.\//, "");
    if (normalizedRule.endsWith("/**")) {
      return candidate.startsWith(normalizedRule.slice(0, -3) + "/");
    }
    return normalizedRule === candidate;
  });
}
