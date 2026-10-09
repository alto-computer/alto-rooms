import {
  Book,
  Calendar,
  Flag,
  LayoutGrid,
  Lightbulb,
  ListChecks,
  Notebook,
  Palette,
  Pencil,
  Puzzle,
  Sparkles,
  Star,
  Target,
  type LucideIcon,
} from "lucide-react";

/** The icons a manifest may name for a slot (roomsd rejects others). */
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
  palette: Palette,
};

export const pluginIcon = (name: string | null | undefined, fallback: LucideIcon = Puzzle): LucideIcon => (name && ICONS[name]) || fallback;
