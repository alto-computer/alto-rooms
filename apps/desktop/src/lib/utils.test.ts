import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("keeps a type-scale size next to a colour, and lets a later size win", () => {
    expect(cn("text-display text-ink")).toBe("text-display text-ink");
    expect(cn("text-sm", "text-body")).toBe("text-body");
  });

  it("merges the app's radius and shadow tokens with the defaults", () => {
    expect(cn("rounded-md", "rounded-menu")).toBe("rounded-menu");
    expect(cn("shadow-md", "shadow-float")).toBe("shadow-float");
  });
});
