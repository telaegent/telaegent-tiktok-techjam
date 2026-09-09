/**
 * Regenerates the committed protocol output schema documents from Zod.
 *
 * The documents have to be committed because the runtime resolver reads them
 * from disk, but a hand-edited .json beside a Zod schema drifts, and the drift
 * is invisible until a model is rejected for obeying the document it was
 * given. `protocol.test.ts` asserts the two stay equal; this script is how you
 * make them equal again after deliberately changing a schema.
 *
 *   npm run regenerate:protocol-schemas
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { clarificationDialogueJsonSchema } from "../src/agent-clarification/contract.js";
import {
  recipientJsonSchema,
  senderJsonSchema,
} from "../src/telagent/protocol/schemas.js";

const outputDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "telagent",
  "output-schemas",
);

const documents: Record<string, unknown> = {
  "sender-turn.schema.json": senderJsonSchema(),
  "recipient-turn.schema.json": recipientJsonSchema(),
  "clarification-dialogue.schema.json": clarificationDialogueJsonSchema(),
};

for (const [name, document] of Object.entries(documents)) {
  await writeFile(
    path.join(outputDirectory, name),
    JSON.stringify(document, null, 2) + "\n",
    "utf8",
  );
  console.log("wrote " + name);
}
