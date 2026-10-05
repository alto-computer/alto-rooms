import { describe, expect, it } from "vitest";
import { onboardPrompt, onboardPromptPath } from "./OnboardingCard";

describe("onboardPromptPath", () => {
  it("uses ~/rooms only for /Users/<name>/rooms or /home/<name>/rooms", () => {
    expect(onboardPromptPath("/Users/me/rooms")).toBe("~/rooms/ONBOARD.md");
    expect(onboardPromptPath("/home/me/rooms")).toBe("~/rooms/ONBOARD.md");
    expect(onboardPrompt("/Users/me/rooms")).toBe("~/rooms/ONBOARD.md 를 읽고 따라 해줘");
  });

  it("is absolute everywhere else", () => {
    expect(onboardPrompt("/Users/me/work/rooms")).toBe("/Users/me/work/rooms/ONBOARD.md 를 읽고 따라 해줘");
    expect(onboardPromptPath("/opt/rooms")).toBe("/opt/rooms/ONBOARD.md");
    expect(onboardPromptPath("/Users/me/agent-rooms")).toBe("/Users/me/agent-rooms/ONBOARD.md");
    expect(onboardPromptPath("/Users/rooms")).toBe("/Users/rooms/ONBOARD.md");
  });
});
