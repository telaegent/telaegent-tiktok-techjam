import { describe, expect, it, vi } from "vitest";
import { collectCursorPages } from "./cursor-pagination";

describe("collectCursorPages", () => {
  it("loads every page in order", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ items: [1, 2], nextCursor: "next" })
      .mockResolvedValueOnce({ items: [3], nextCursor: null });

    await expect(collectCursorPages(load)).resolves.toEqual([1, 2, 3]);
    expect(load.mock.calls).toEqual([[undefined], ["next"]]);
  });

  it("fails instead of polling a repeated cursor forever", async () => {
    const load = vi.fn().mockResolvedValue({ items: [], nextCursor: "same" });
    await expect(collectCursorPages(load)).rejects.toThrow("repeated cursor");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
