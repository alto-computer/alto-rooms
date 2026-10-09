import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { usePlugins, usePluginsStore, useReadOnly } from "@/data/hooks";
import { cn } from "@/lib/utils";
import { pluginIcon } from "@/plugins/icons";
import { addsLines, permissionLine } from "@/plugins/permissions";
import { usable, type HostPlugin } from "@/plugins/pluginsStore";
import { Row, Section } from "./settingsUi";

/** Settings › Plugins: every installed plugin, what it adds and may do, and its on/off switch. */
export function PluginSettings() {
  const { list, loaded } = usePlugins();
  return (
    <Section section="plugins" title="Plugins">
      {list.length ? list.map((p) => <PluginRow key={p.id} plugin={p} />) : <Row label={<span className="text-ink-2">{loaded ? "No plugins installed" : "…"}</span>} />}
    </Section>
  );
}

function PluginRow({ plugin: p }: { plugin: HostPlugin }) {
  const store = usePluginsStore();
  const readOnly = useReadOnly();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<"on" | "off" | null>(null);
  const on = usable(p);
  const Icon = pluginIcon(p.slots.tab?.icon ?? p.slots.artifactSidePanel?.icon);

  const turn = async (next: boolean) => {
    setBusy(true);
    setFailed(null);
    try {
      // On grants exactly the permissions listed in this row, as the enable card does.
      await (next ? store.setEnabled(p.id, true, p.permissions) : store.setEnabled(p.id, false));
    } catch (e) {
      console.warn(`could not turn ${p.id} ${next ? "on" : "off"}`, e);
      setFailed(next ? "on" : "off");
    } finally {
      setBusy(false);
    }
  };

  // A re-ask lists what the user has not allowed yet as new.
  const isNew = (perm: string) => p.granted !== null && !p.granted.includes(perm);
  const lines = p.status === "ok" ? [...addsLines(p), ...p.permissions.map((x) => permissionLine(x) + (isNew(x) ? " (new)" : ""))] : [];
  const problem =
    p.status !== "ok" ? `Couldn't load: ${p.reason ?? "invalid manifest"}` : !p.compatible ? `Needs Rooms ${p.minAppVersion} or later` : null;

  return (
    <Row
      className="items-start py-3"
      label={
        <span className="flex items-center gap-2.5">
          <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg bg-surface", on ? "text-ink" : "text-ink-3")}>
            <Icon size={16} strokeWidth={1.5} aria-hidden />
          </span>
          <span className="font-medium">{p.status === "ok" ? p.name : p.id}</span>
          {p.status === "ok" ? <span className="text-small text-ink-3">{p.version}</span> : null}
        </span>
      }
      detail={
        <div className="flex flex-col gap-1 pl-[38px]">
          {p.description ? <p className="text-ink-2">{p.description}</p> : null}
          {lines.length ? (
            <ul aria-label={`${p.name}: what it adds and can do`} className="flex flex-col text-ink-3">
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          {problem ? <p className="text-error">{problem}</p> : null}
          {failed ? (
            <p role="alert" className="text-error">
              Couldn't turn it {failed}
            </p>
          ) : null}
        </div>
      }
    >
      {problem ? null : (
        <Switch className="mt-[5px]" aria-label={p.name} checked={on} disabled={readOnly || busy} onCheckedChange={(next) => void turn(next)} />
      )}
    </Row>
  );
}
