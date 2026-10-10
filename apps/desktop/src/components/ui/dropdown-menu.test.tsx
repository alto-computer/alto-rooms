import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "./dropdown-menu";

afterEach(() => {
  cleanup();
});

it("a submenu renders outside its parent menu, so the parent's blur and overflow can't anchor or clip it", async () => {
  render(
    <DropdownMenu>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem>Leaf</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  fireEvent.pointerDown(screen.getByRole("button", { name: "Open" }), { button: 0, ctrlKey: false });
  const parent = await screen.findByRole("menu", { name: "Open" });
  fireEvent.click(screen.getByRole("menuitem", { name: "More" }));
  const child = await screen.findByRole("menu", { name: "More" });
  expect(parent.contains(child)).toBe(false);
});
