import { useEffect, useState } from "react";
import type { AskTarget, AskTurn } from "@alto-rooms/protocol-ts";
import { useAsksStore } from "@/data/hooks";
import { loadModel, saveModel } from "./askModel";

/**
 * Where an ask from this doc goes (null until roomsd answers), the model picked for that agent,
 * and the model a retry of `t` uses: its own while the agent still offers it.
 */
export function useAskTarget(doc: { roomId: string; artifactId: string }, shown: boolean) {
  const store = useAsksStore();
  const { roomId, artifactId } = doc;
  const key = `${roomId}/${artifactId}`;
  // Keyed by doc, so a newly shown doc never sends the previous doc's model.
  const [state, setState] = useState<{ key: string; target: AskTarget | null; model: string | null } | null>(null);
  useEffect(() => {
    if (!shown) return;
    let live = true;
    void store.target({ roomId, artifactId }).then((target) => {
      if (live) setState({ key: `${roomId}/${artifactId}`, target, model: target ? loadModel(target.agent, target.models) : null });
    });
    return () => {
      live = false;
    };
  }, [shown, store, roomId, artifactId]);
  const current = state?.key === key ? state : null;
  const target = current?.target ?? null;
  const model = current?.model ?? null;
  const pick = (m: string | null) => {
    if (!target) return;
    saveModel(target.agent, m);
    setState({ key, target, model: m });
  };
  const modelFor = (t: AskTurn) => (t.model && target?.models.includes(t.model) ? t.model : model);
  return { target, model, pick, modelFor };
}
