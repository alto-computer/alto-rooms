import { useEffect, useRef, useState } from "react";
import { CircleAlert, LoaderCircle, X } from "lucide-react";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useAsksStore, useClient, useInfo } from "@/data/hooks";
import { GENERIC_ERROR } from "@/lib/errors";
import { cn } from "@/lib/utils";

/** What roomsd stores (it reads the type from the bytes; SVG is a document, not an image). */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGES = 5;
const MAX_BYTES = 10 * 1024 * 1024;

export type Attachment = { key: string; preview: string; name: string; id: string | null; error: string | null };

let nextKey = 0;

/** Images picked for the next question: each uploads as soon as it's added, with its own preview and error. */
export function useAttachments(onRefused: (message: string) => void) {
  const store = useAsksStore();
  const [items, setItems] = useState<Attachment[]>([]);
  const live = useRef(items);
  live.current = items;
  // Previews are object URLs: let them go with the bar.
  useEffect(() => () => live.current.forEach((a) => URL.revokeObjectURL(a.preview)), []);

  const update = (key: string, patch: Partial<Attachment>) => setItems((xs) => xs.map((a) => (a.key === key ? { ...a, ...patch } : a)));

  const add = (files: Iterable<File>) => {
    const images = Array.from(files).filter((f) => IMAGE_TYPES.includes(f.type));
    if (images.length === 0) return false;
    const room = MAX_IMAGES - live.current.length;
    if (images.length > room) onRefused(`At most ${MAX_IMAGES} images per question`);
    const added = images.slice(0, Math.max(0, room)).map((f): Attachment & { file: File } => ({
      key: `att-${nextKey++}`, preview: URL.createObjectURL(f), name: f.name || "Pasted image", id: null, file: f,
      error: f.size > MAX_BYTES ? "An image must be under 10 MB" : null,
    }));
    setItems((xs) => [...xs, ...added.map(({ file: _f, ...a }) => a)]);
    for (const a of added) {
      if (a.error) continue;
      store.uploadImage(a.file).then(
        (id) => update(a.key, { id }),
        (e) => update(a.key, { error: e instanceof RoomsApiError ? e.message : GENERIC_ERROR }),
      );
    }
    return true;
  };

  const remove = (key: string) => {
    const a = live.current.find((x) => x.key === key);
    if (a) URL.revokeObjectURL(a.preview);
    setItems((xs) => xs.filter((x) => x.key !== key));
  };

  /** Drops the ones that went out with a question. */
  const clear = (keys: string[]) => {
    for (const a of live.current) if (keys.includes(a.key)) URL.revokeObjectURL(a.preview);
    setItems((xs) => xs.filter((x) => !keys.includes(x.key)));
  };

  const uploading = items.some((a) => !a.id && !a.error);
  const failed = items.some((a) => a.error);
  return { items, add, remove, clear, uploading, failed };
}

/** The picked images above the input: a thumbnail each, a spinner while it uploads, × to drop it. */
export function AttachmentStrip({ items, onRemove }: { items: Attachment[]; onRemove: (key: string) => void }) {
  if (items.length === 0) return null;
  return (
    <ul aria-label="Attached images" className="flex flex-wrap gap-2 pt-1">
      {items.map((a) => (
        <li key={a.key} className="group/att relative" title={a.error ?? a.name}>
          <img
            src={a.preview}
            alt={a.name}
            className={cn("size-12 rounded-lg border border-[#e3e3e3] object-cover", !a.id && !a.error && "opacity-50", a.error && "border-[#c13515] opacity-60")}
          />
          {!a.id && !a.error ? <LoaderCircle aria-label="Uploading" className="absolute inset-0 m-auto size-4 animate-spin text-ink" /> : null}
          {a.error ? <CircleAlert aria-label={a.error} className="absolute inset-0 m-auto size-4 text-[#c13515]" /> : null}
          <button
            type="button"
            aria-label={`Remove ${a.name}`}
            onClick={() => onRemove(a.key)}
            className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-[#e3e3e3] bg-white text-ink-2 shadow-sm hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
          >
            <X className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A question's images, small and to the right like the question; click one to see it whole. */
export function TurnImages({ ids }: { ids: string[] }) {
  const info = useInfo();
  const client = useClient();
  const [open, setOpen] = useState<string | null>(null);
  if (ids.length === 0 || !info) return null;
  const url = (id: string) => client.askImageUrl(info, id);
  return (
    <>
      <div className="ml-auto flex w-fit max-w-[80%] flex-wrap justify-end gap-1.5">
        {ids.map((id) => (
          <button key={id} type="button" aria-label="Open image" onClick={() => setOpen(id)} className="rounded-lg focus-visible:outline-2 focus-visible:outline-ink">
            <img src={url(id)} alt="" loading="lazy" className="size-16 rounded-lg border border-[#e3e3e3] object-cover" />
          </button>
        ))}
      </div>
      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="w-auto max-w-[90vw] p-2 sm:max-w-[90vw]">
          <DialogTitle className="sr-only">Attached image</DialogTitle>
          {open ? <img src={url(open)} alt="" className="max-h-[85vh] max-w-[85vw] rounded-md object-contain" /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
