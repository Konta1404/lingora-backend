/** JSON-schema builders for Structured Outputs (strict mode: every property required, no extras). */
export type Schema = Record<string, unknown>;

export const obj = (props: Record<string, Schema>): Schema => ({
  type: "object",
  properties: props,
  required: Object.keys(props),
  additionalProperties: false,
});
export const str = (description: string): Schema => ({ type: "string", description });
export const int = (description: string): Schema => ({ type: "integer", description });
export const bool = (description = ""): Schema => ({ type: "boolean", description });
export const arr = (items: Schema, description = ""): Schema => ({ type: "array", items, description });
