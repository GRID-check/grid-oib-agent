/**
 * The lifecycle wire schemas, as JSON Schema, for the Python tier.
 *
 * ## Why this exists at all
 *
 * The agent's `file_draft` tool (slice 3) has to describe the same request body
 * the internal route parses. Writing a Pydantic model beside the zod one is two
 * hand-written descriptions of one contract, and the repo already has the
 * cautionary tale: `AUDIT_ACTIONS` and the provisioning script's `SCHEMAS` array
 * were two lists meant to be one and drifted by nine actions, with the only
 * symptom an ERROR log on the side that never throws. So the zod schemas are the
 * source, this converts them, and `tests/fixtures/document-lifecycle.schema.json`
 * is the committed artifact both languages read.
 *
 * ## Why the converter is written out rather than pulled in
 *
 * `zod-to-json-schema` is the library, and it is the right answer the day zod is
 * upgraded or a schema grows a shape this cannot express. It is not in the
 * lockfile, and adding a dependency has to be worth the lockfile churn in the
 * image and in CI; forty lines that handle exactly the node kinds
 * `lifecycle-types.ts` uses — object, string, number, boolean, literal, enum,
 * array, optional, nullable, default, discriminated union — is the smaller
 * change. The bound is deliberate and enforced: an unsupported node THROWS
 * rather than emitting `{}`, so a schema this cannot describe fails the spec
 * instead of silently exporting a contract that permits anything. That failure
 * is the signal to add the dependency.
 */

import { z, type ZodTypeAny } from 'zod'
import { DOCUMENT_LIFECYCLE_WIRE_SCHEMAS } from './lifecycle-types'

/** A JSON Schema node, as much of one as this converter emits. */
export type JsonSchemaNode = Record<string, unknown>

/** A zod node this converter does not know how to describe. */
export class UnsupportedSchemaNodeError extends Error {
  constructor(readonly typeName: string) {
    super(
      `document-lifecycle JSON Schema export cannot describe a ${typeName}. ` +
        'Add the case here, or take the zod-to-json-schema dependency.',
    )
    this.name = 'UnsupportedSchemaNodeError'
  }
}

function objectNode(schema: z.ZodObject<z.ZodRawShape>): JsonSchemaNode {
  const properties: Record<string, JsonSchemaNode> = {}
  const required: string[] = []
  for (const [key, value] of Object.entries(schema.shape)) {
    const field = value as ZodTypeAny
    properties[key] = toJsonSchema(field)
    // `.default()` makes a field optional on the wire and present after
    // parsing, which is exactly what a required-list must NOT claim.
    if (!field.isOptional()) required.push(key)
  }
  const node: JsonSchemaNode = { type: 'object', properties }
  if (required.length > 0) node.required = required
  // `.strict()` on every request body is a decision, not an accident: an
  // unknown key is a caller believing in a field this tier does not have.
  node.additionalProperties = schema._def.unknownKeys === 'strict' ? false : true
  return node
}

function stringNode(schema: z.ZodString): JsonSchemaNode {
  const node: JsonSchemaNode = { type: 'string' }
  for (const check of schema._def.checks) {
    if (check.kind === 'min') node.minLength = check.value
    if (check.kind === 'max') node.maxLength = check.value
    if (check.kind === 'uuid') node.format = 'uuid'
  }
  return node
}

/** One zod node as JSON Schema. Throws for anything it cannot describe. */
export function toJsonSchema(schema: ZodTypeAny): JsonSchemaNode {
  const definition = schema._def as { typeName: string; [key: string]: unknown }
  switch (definition.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject:
      return objectNode(schema as z.ZodObject<z.ZodRawShape>)
    case z.ZodFirstPartyTypeKind.ZodString:
      return stringNode(schema as z.ZodString)
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return (schema as z.ZodNumber).isInt ? { type: 'integer' } : { type: 'number' }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: 'boolean' }
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return { const: (schema as z.ZodLiteral<string>).value }
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return { type: 'string', enum: [...(schema as z.ZodEnum<[string, ...string[]]>).options] }
    case z.ZodFirstPartyTypeKind.ZodArray:
      return {
        type: 'array',
        items: toJsonSchema((schema as z.ZodArray<ZodTypeAny>).element),
        ...maxItems(schema as z.ZodArray<ZodTypeAny>),
      }
    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodDefault:
      return toJsonSchema((definition.innerType as ZodTypeAny) ?? z.unknown())
    case z.ZodFirstPartyTypeKind.ZodNullable:
      // `anyOf` rather than a type array, because the inner node may carry
      // constraints (`maxLength`, `enum`) that a `["string", "null"]` shorthand
      // would silently apply to `null` as well.
      return { anyOf: [toJsonSchema(definition.innerType as ZodTypeAny), { type: 'null' }] }
    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
      return {
        oneOf: [...(schema as z.ZodDiscriminatedUnion<string, never[]>).options].map((option) =>
          toJsonSchema(option as ZodTypeAny),
        ),
        discriminator: {
          propertyName: (schema as z.ZodDiscriminatedUnion<string, never[]>).discriminator,
        },
      }
    default:
      throw new UnsupportedSchemaNodeError(definition.typeName)
  }
}

function maxItems(schema: z.ZodArray<ZodTypeAny>): JsonSchemaNode {
  const max = schema._def.maxLength?.value
  return max === undefined || max === null ? {} : { maxItems: max }
}

/**
 * The whole export, exactly as the fixture holds it.
 *
 * `$defs` keyed by the names in `DOCUMENT_LIFECYCLE_WIRE_SCHEMAS`, so the Python
 * side loads one file and looks a shape up by name rather than by position.
 */
export function documentLifecycleJsonSchema(): JsonSchemaNode {
  const defs: Record<string, JsonSchemaNode> = {}
  for (const [name, schema] of Object.entries(DOCUMENT_LIFECYCLE_WIRE_SCHEMAS)) {
    defs[name] = toJsonSchema(schema as ZodTypeAny)
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Grid document lifecycle wire contract',
    description:
      'Generated from frontends/ui/src/lib/documents/lifecycle-types.ts. Do not edit by hand: ' +
      'lifecycle-schema.spec.ts rewrites this file and fails when it is stale.',
    $defs: defs,
  }
}
