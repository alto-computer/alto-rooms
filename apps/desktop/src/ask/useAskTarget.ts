import { useEffect, useState } from "react";
import type { AskScope, AskTarget, AskTurn } from "@alto-rooms/protocol-ts";
import { scopeKey } from "@alto-rooms/protocol-ts";
import { useAsksStore } from "@/data/hooks";
import { loadModel, saveModel } from "./askModel";

/**
 * Where an ask in this scope goes (null until roomsd answers), the model picked for that agent,
 * and the model a retry of `t` uses: its own while the agent still offers it.
 */
export function useAskTarget(scope: AskScope, shown: boolean) {
  const store = useAsksStore();
  const key = scopeKey(scope);
  // Keyed by scope, so a newly shown scope never sends the previous one's model.
  const [state, setState] = useState<{ key: string; target: AskTarget | null; model: string | null } | null>(null);
  // The scope object is rebuilt on every render; its key says when it really changed.
  useEffect(() => {
    if (!shown) return;
    let live = true;
    void store.target(scope).then((target) => {
      if (live) setState({ key, target, model: target ? loadModel(target.agent, target.models) : null });
    });
    return () => {
      live = false;
    };
  }, [shown, store, key]);
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
