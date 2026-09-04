export function getOrCreateIdempotencyKey(
  keys: Map<string, string>,
  scope: string,
  operation: string,
  createId: () => string = () => crypto.randomUUID(),
): string {
  const existing = keys.get(scope);
  if (existing) return existing;

  const created = `${operation}:${scope}:${createId()}`;
  keys.set(scope, created);
  return created;
}
