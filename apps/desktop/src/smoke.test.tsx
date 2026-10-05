import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

/** jsdom has no EventSource; the stores only need something to subscribe to. */
class FakeEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((m: MessageEvent) => void) | null = null;
  close() {}
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", () => new Promise(() => {})); // roomsd never answers in the smoke test
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.__ROOMS_DEV__;
});

describe("App smoke", () => {
  it("renders the Rooms placeholder once connected", async () => {
    window.__ROOMS_DEV__ = { baseUrl: "http://127.0.0.1:4317", token: "t", home: "/h" };
    render(<App />);
    expect(await screen.findByText("Rooms")).toBeTruthy();
  });

  it("shows the error panel and retries", async () => {
    render(<App />);
    expect(await screen.findByText("Couldn't start the Rooms core")).toBeTruthy();
    window.__ROOMS_DEV__ = { baseUrl: "http://127.0.0.1:4317", token: "t", home: "/h" };
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText("Rooms")).toBeTruthy();
  });
});
