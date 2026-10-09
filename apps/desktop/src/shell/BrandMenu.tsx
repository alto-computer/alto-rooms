import { ChevronDown, Contrast, Moon, Sun, type LucideIcon } from "lucide-react";
import { DropdownMenu as MenuPrimitive } from "radix-ui";
import { PeekGlyph } from "@/components/PeekGlyph";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useViewer, useViewerStore } from "@/data/hooks";
import { isAppearance, type Appearance } from "@/lib/appearance";

const OPTIONS: { value: Appearance; label: string; Icon: LucideIcon }[] = [
  { value: "system", label: "System", Icon: Contrast },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

/** The brand row ("Rooms ▾"): opens the app menu, which holds Appearance. */
export function BrandMenu() {
  const viewer = useViewerStore();
  const { appearance } = useViewer();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="group flex h-8 min-w-0 items-center gap-[7px] rounded-lg pr-2 pl-1.5 text-ink outline-none hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-ink data-[state=open]:bg-surface-strong">
        <PeekGlyph size={24} className="size-[22px] shrink-0 origin-[50%_80%] transition-transform duration-300 ease-out group-hover:-rotate-8" />
        <span className="font-display text-heading font-medium tracking-[-0.005em]">Rooms</span>
        <ChevronDown size={12} strokeWidth={1.75} aria-hidden className="-ml-px text-ink-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-[268px] p-1.5 text-body">
        <DropdownMenuLabel className="px-2 pt-1.5 pb-2 text-caption font-semibold tracking-[.02em] text-ink-3">Appearance</DropdownMenuLabel>
        <MenuPrimitive.RadioGroup
          value={appearance}
          onValueChange={(v) => isAppearance(v) && viewer.setAppearance(v)}
          aria-label="Appearance"
          className="mx-1 flex gap-0.5 rounded-lg bg-surface p-[3px] shadow-[inset_0_0_0_1px_var(--hairline)]"
        >
          {OPTIONS.map(({ value, label, Icon }) => (
            <MenuPrimitive.RadioItem
              key={value}
              value={value}
              // Stay open, so the change shows while the menu is still there.
              onSelect={(e) => e.preventDefault()}
              className="flex h-7 flex-1 cursor-default items-center justify-center gap-1.5 rounded-md text-small font-medium text-ink-2 outline-none select-none data-highlighted:text-ink data-[state=checked]:bg-sheet data-[state=checked]:text-ink data-[state=checked]:shadow-sheet"
            >
              <Icon size={14} strokeWidth={1.5} aria-hidden />
              {label}
            </MenuPrimitive.RadioItem>
          ))}
        </MenuPrimitive.RadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
