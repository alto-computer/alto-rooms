import {
  Book,
  Calendar,
  Flag,
  LayoutGrid,
  Lightbulb,
  ListChecks,
  Notebook,
  Pencil,
  Puzzle,
  Sparkles,
  Star,
  Target,
  type LucideIcon,
} from "lucide-react";

/** The icons a manifest may name for its tab (roomsd rejects others); anything missing shows Puzzle. */
const ICONS: Record<string, LucideIcon> = {
  target: Target,
  pencil: Pencil,
  "list-checks": ListChecks,
  calendar: Calendar,
  star: Star,
  book: Book,
  flag: Flag,
  "layout-grid": LayoutGrid,
  sparkles: Sparkles,
  notebook: Notebook,
  lightbulb: Lightbulb,
  puzzle: Puzzle,
};

export const pluginIcon = (name: string | null | undefined): LucideIcon => (name && ICONS[name]) || Puzzle;
