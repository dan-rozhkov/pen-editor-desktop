// A small zod v3 -> JSON Schema converter, only for the node types the browse tool schemas of
// @sideform/browser-agent use (object, string, number, boolean, enum, array, optional, effects).
// zod 3.25 ships `z.toJSONSchema` for v4 schemas only, and the package's schemas are v3. An
// unsupported node throws, so a package upgrade that adds one fails the generator, not the manifest.

interface ZodDef {
  typeName?: string;
  description?: string;
  checks?: { kind: string; value?: number; inclusive?: boolean }[];
  innerType?: ZodLike;
  schema?: ZodLike;
  type?: ZodLike;
  values?: string[];
  minLength?: { value: number } | null;
  maxLength?: { value: number } | null;
  shape?: () => Record<string, ZodLike>;
}

export interface ZodLike {
  _def: ZodDef;
  description?: string;
}

type Json = Record<string, unknown>;

export function zodV3ToJsonSchema(schema: ZodLike): Json {
  const def = schema._def;
  const out = convert(schema);
  const description = schema.description ?? def.description;
  if (description && out.description === undefined) out.description = description;
  return out;
}

function convert(schema: ZodLike): Json {
  const def = schema._def;
  switch (def.typeName) {
    case "ZodObject": {
      const shape = def.shape?.() ?? {};
      const properties: Record<string, Json> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodV3ToJsonSchema(value);
        if (!isOptional(value)) required.push(key);
      }
      return { type: "object", properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false };
    }
    case "ZodString": {
      const out: Json = { type: "string" };
      for (const c of def.checks ?? []) {
        if (c.kind === "min") out.minLength = c.value;
        else if (c.kind === "max") out.maxLength = c.value;
        else throw new Error(`Unsupported string check "${c.kind}"`);
      }
      return out;
    }
    case "ZodNumber": {
      const out: Json = { type: "number" };
      for (const c of def.checks ?? []) {
        if (c.kind === "int") out.type = "integer";
        else if (c.kind === "min" || c.kind === "max") {
          const exclusive = c.inclusive === false;
          const key = c.kind === "min" ? (exclusive ? "exclusiveMinimum" : "minimum") : exclusive ? "exclusiveMaximum" : "maximum";
          out[key] = c.value;
        } else throw new Error(`Unsupported number check "${c.kind}"`);
      }
      return out;
    }
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum":
      return { type: "string", enum: [...(def.values ?? [])] };
    case "ZodArray": {
      const out: Json = { type: "array", items: zodV3ToJsonSchema(def.type as ZodLike) };
      if (def.minLength) out.minItems = def.minLength.value;
      if (def.maxLength) out.maxItems = def.maxLength.value;
      return out;
    }
    case "ZodDefault":
      throw new Error("Unsupported zod node \"ZodDefault\" in a browse tool schema (its default is not emitted)");
    case "ZodOptional":
      return zodV3ToJsonSchema(def.innerType as ZodLike);
    case "ZodEffects":
      // An effect only validates or transforms; it does not change the shape the model sees.
      return zodV3ToJsonSchema(def.schema as ZodLike);
    default:
      throw new Error(`Unsupported zod node "${def.typeName}" in a browse tool schema`);
  }
}

/** Optional through any number of ZodEffects wrappers; a default also makes a property optional. */
function isOptional(schema: ZodLike): boolean {
  const t = schema._def.typeName;
  if (t === "ZodOptional" || t === "ZodDefault") return true;
  if (t === "ZodEffects") return isOptional(schema._def.schema as ZodLike);
  return false;
}
