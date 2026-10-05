import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App smoke", () => {
  it("renders the Rooms placeholder", () => {
    render(<App />);
    expect(screen.getByText("Rooms")).toBeTruthy();
  });
});
