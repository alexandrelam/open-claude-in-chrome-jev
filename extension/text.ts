// Text from a value that arrived untyped (a JSON message, a tool argument).
// Strings and numbers read as themselves; anything else (a missing field, an
// object) takes the fallback rather than becoming "[object Object]".
export function textOf(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value || fallback;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return fallback;
}
