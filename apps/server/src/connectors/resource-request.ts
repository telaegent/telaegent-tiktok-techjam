import { z } from "zod";

/**
 * What one agent may ask another person's machine for.
 *
 * This is deliberately a leaf: zod and nothing else. The same shape is emitted
 * by a private agent's turn, validated when the connector posts its result,
 * routed by the cloud and enforced on the owner's machine, and a second
 * definition anywhere along that path would eventually disagree with the first.
 * Keeping it importable without pulling in a filesystem is what lets the
 * protocol layer reuse it rather than restate it.
 */

/**
 * Shape of an identifier the cloud is allowed to store and route.
 *
 * Kept byte-for-byte compatible with the `resource_capability_grants.resource_id`
 * check constraint so a locally minted identifier can never be rejected by the
 * routing layer it was minted for.
 */
export const RESOURCE_ID_PATTERN = /^resource_[A-Za-z0-9_-]{16,120}$/;

export const resourceIdSchema = z.string().regex(RESOURCE_ID_PATTERN);

/**
 * Human-facing name for a resource the owner's connector resolved locally.
 *
 * This is deliberately narrower than an arbitrary path. It is normalized to
 * forward slashes, must remain project-relative, and cannot contain control
 * characters or traversal segments. The cloud may render this label, but it
 * must never receive the canonical path it was derived from.
 */
export const resourceDisplayLabelSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/\p{Cc}/u.test(value))
  .refine((value) => !value.includes("\\"))
  .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:/.test(value))
  .refine((value) =>
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
  );

export type ResourceDisplayLabel = z.infer<typeof resourceDisplayLabelSchema>;

const reason = z.string().min(1).max(2_000).refine((value) => !value.includes("\0"));

/**
 * What a peer's agent may say.
 *
 * Either it names an identifier it was already given, or it describes the file
 * it believes it needs. There is deliberately no third form: an agent can never
 * express a canonical path, so it can never reach outside what it was handed.
 */
export const connectorResourceRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("resource"),
    resourceId: resourceIdSchema,
    reason,
  }),
  z.strictObject({
    kind: z.literal("hint"),
    // Bounded project-relative text (build plan 8.3). Never resolved locally;
    // it exists to be shown to the owning human, who chooses the file.
    hint: z.string().min(1).max(512).refine((value) => !value.includes("\0")),
    reason,
  }),
]);

export type ConnectorResourceRequest = z.infer<typeof connectorResourceRequestSchema>;
