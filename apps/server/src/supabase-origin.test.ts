import { describe, expect, it } from "vitest";
import { isSafeSupabaseOrigin } from "./supabase-origin.js";

describe("isSafeSupabaseOrigin", () => {
  it.each([
    "https://project.supabase.co",
    "http://127.0.0.1:54321",
    "http://localhost:54321",
    "http://[::1]:54321",
  ])("accepts secure hosted and loopback development origins: %s", (value) => {
    expect(isSafeSupabaseOrigin(new URL(value))).toBe(true);
  });

  it.each([
    "http://project.supabase.co",
    "http://192.168.1.10:54321",
    "https://user:password@project.supabase.co",
    "https://project.supabase.co/rest/v1",
    "https://project.supabase.co?key=value",
    "https://project.supabase.co#fragment",
  ])("rejects unsafe or non-origin Supabase URLs: %s", (value) => {
    expect(isSafeSupabaseOrigin(new URL(value))).toBe(false);
  });
});
