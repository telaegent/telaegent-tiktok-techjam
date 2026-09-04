export type CursorPage<T> = Readonly<{
  items: readonly T[];
  nextCursor: string | null;
}>;

/** Drains a bounded cursor API while refusing looping or malformed pagination. */
export async function collectCursorPages<T>(
  loadPage: (cursor: string | undefined) => Promise<CursorPage<T>>,
  maximumPages = 1_000,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  for (let pageNumber = 0; pageNumber < maximumPages; pageNumber += 1) {
    const page = await loadPage(cursor);
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    if (seen.has(page.nextCursor)) {
      throw new Error("Pagination returned a repeated cursor");
    }
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  throw new Error("Pagination exceeded its safety limit");
}
