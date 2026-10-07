import { createContext, useContext } from "react";

/** The id of the tab a view is mounted in ("" outside a tab, e.g. in tests). */
export const CurrentTabContext = createContext("");

export const useCurrentTabId = (): string => useContext(CurrentTabContext);

/** False while the view's tab is kept alive in the background (see AppShell's kept doc tabs). */
export const TabVisibleContext = createContext(true);

export const useTabVisible = (): boolean => useContext(TabVisibleContext);
