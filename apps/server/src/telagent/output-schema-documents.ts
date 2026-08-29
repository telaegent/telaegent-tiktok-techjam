import { z } from "zod";
import { outputSchemasByName } from "./schemas.js";

export type OutputSchemaFileName = keyof typeof outputSchemasByName;
export type JsonSchemaDocument = Record<string, unknown> & {
  $schema?: string;
  $id: string;
  title: string;
  additionalProperties?: boolean;
};

const titleByName: Record<OutputSchemaFileName, string> = {
  "plan-intent.schema.json": "Telagent Plan Intent Agent Output v1",
  "status.schema.json": "Telagent Status Agent Output v1",
  "resolution.schema.json": "Telagent Resolution Agent Output v1",
  "implementation-result.schema.json": "Telagent Implementation Result Agent Output v1",
  "context-request.schema.json": "Telagent Context Request Agent Output v1",
  "context-pack.schema.json": "Telagent ContextPack Agent Output v1",
  "dependency-change.schema.json": "Telagent Dependency Change Agent Output v1",
  "plan-revision.schema.json": "Telagent Plan Revision Agent Output v1",
};

export function buildOutputSchemaDocuments(): Record<
  OutputSchemaFileName,
  JsonSchemaDocument
> {
  return Object.fromEntries(
    Object.entries(outputSchemasByName).map(([name, schema]) => {
      const fileName = name as OutputSchemaFileName;
      const generated = z.toJSONSchema(schema as z.ZodType) as Record<string, unknown>;
      return [
        fileName,
        {
          ...generated,
          $id: `urn:telagent:output-schema:${fileName.replace(".schema.json", "")}:v1`,
          title: titleByName[fileName],
        },
      ];
    }),
  ) as unknown as Record<OutputSchemaFileName, JsonSchemaDocument>;
}
