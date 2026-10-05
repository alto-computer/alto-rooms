import type { Tab } from "@/data/viewerStore";

/* Minimal new-tab panel until Task 7 replaces it with NewTabView. */
export function TabPlaceholder(_props: { tab: Extract<Tab, { kind: "new" }> }) {
  return (
    <div className="flex flex-1 flex-col bg-white px-12 pt-14 pb-10">
      <h1 className="text-[32px] font-medium text-ink">지난 방문 이후</h1>
    </div>
  );
}
