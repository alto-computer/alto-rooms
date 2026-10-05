import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";

afterEach(() => {
  cleanup();
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
    expect(await screen.findByText("Rooms 코어를 시작하지 못했어요")).toBeTruthy();
    window.__ROOMS_DEV__ = { baseUrl: "http://127.0.0.1:4317", token: "t", home: "/h" };
    fireEvent.click(screen.getByText("다시 시도"));
    expect(await screen.findByText("Rooms")).toBeTruthy();
  });
});
