import { useEffect, useRef } from "react";
import { Contrast, Moon, Sun, type LucideIcon } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { useViewer, useViewerStore } from "@/data/hooks";
import { isAppearance, type Appearance } from "@/lib/appearance";
import { onSettingsSection, settingsSectionId, takeSettingsSection } from "@/lib/settings";
import { Row, Section } from "./settingsUi";

/** The Settings tab: Appearance, Auto-sort and Plugins in one column. */
export function SettingsView() {
  const ref = useRef<HTMLDivElement>(null);

  // "Plugin settings…" and the inbox's auto-sort line ask for a section.
  useEffect(() => {
    const show = () => {
      const s = takeSettingsSection();
      if (s) ref.current?.querySelector(`#${settingsSectionId(s)}`)?.scrollIntoView({ block: "start" });
    };
    show();
    return onSettingsSection(show);
  }, []);

  return (
    <div ref={ref} data-scroll-root className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:thin]">
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-8 px-8 pt-12 pb-16">
        <h1 className="px-1 font-display text-display font-medium tracking-[-0.015em] text-ink">Settings</h1>
        <AppearanceSection />
      </div>
    </div>
  );
}

const APPEARANCES: { value: Appearance; label: string; Icon: LucideIcon }[] = [
  { value: "system", label: "System", Icon: Contrast },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

function AppearanceSection() {
  const viewer = useViewerStore();
  const { appearance } = useViewer();
  return (
    <Section section="appearance" title="Appearance">
      <Row label="Theme">
        <RadioGroup.Root
          value={appearance}
          onValueChange={(v) => isAppearance(v) && viewer.setAppearance(v)}
          aria-label="Appearance"
          orientation="horizontal"
          className="flex w-[264px] shrink-0 gap-0.5 rounded-lg bg-surface p-[3px] shadow-[inset_0_0_0_1px_var(--hairline)]"
        >
          {APPEARANCES.map(({ value, label, Icon }) => (
            <RadioGroup.Item
              key={value}
              value={value}
              className="flex h-7 flex-1 cursor-default items-center justify-center gap-1.5 rounded-md text-small font-medium text-ink-2 outline-none select-none hover:text-ink focus-visible:outline-2 focus-visible:outline-ink data-[state=checked]:bg-sheet data-[state=checked]:text-ink data-[state=checked]:shadow-sheet"
            >
              <Icon size={14} strokeWidth={1.5} aria-hidden />
              {label}
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
      </Row>
    </Section>
  );
}
