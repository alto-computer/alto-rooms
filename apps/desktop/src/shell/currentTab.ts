import { createContext, useContext } from "react";

/** The id of the tab a view is mounted in ("" outside a tab, e.g. in tests). */
export const CurrentTabContext = createContext("");

export const useCurrentTabId = (): string => useContext(CurrentTabContext);
