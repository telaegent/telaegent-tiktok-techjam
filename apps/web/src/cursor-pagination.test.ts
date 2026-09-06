import { describe, expect, it, vi } from "vitest";
import { collectCursorPages, collectCursorSnapshot } from "./cursor-pagination";

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

describe("collectCursorSnapshot", () => {
  it("retains the final cursor for incremental polling", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({
        items: [1, 2],
        nextCursor: "page-2",
        pollCursor: "after-2",
      })
      .mockResolvedValueOnce({
        items: [3],
        nextCursor: null,
        pollCursor: "after-3",
      });

    await expect(collectCursorSnapshot(load)).resolves.toEqual({
      items: [1, 2, 3],
      pollCursor: "after-3",
    });
  });
});
