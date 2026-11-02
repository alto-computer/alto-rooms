import { useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { StudyRoomSummary, StudyVolumeSummary } from "@alto-rooms/protocol-ts";
import { useClient, useReadOnly, useStudy, useStudyStore } from "@/data/hooks";
import { errorCopy } from "@/lib/errors";
import { clothOf, isSubmit, latestVolume, versionOf } from "./study";
import { Axes, useStudyGo } from "./StudyNav";

/** Books a board holds: the newest published ones, then the draft. */
const BOOKS_PER_BOARD = 6;
/** The wall always shows at least this many boards, so a new Study still looks like shelving. */
const MIN_BOARDS = 6;
/** Spine widths and heights, cycled per book so a shelf never looks stamped out. */
const WIDTHS = [30, 34, 28, 36, 32, 33];
const HEIGHTS = [150, 160, 142, 166, 154, 146];

const two = (n: number) => String(n).padStart(2, "0");

/** What the left side shows: the room count, a hovered room's newest volume, or the empty board's +. */
type Lede = { kind: "count" } | { kind: "room"; room: StudyRoomSummary } | { kind: "new" };

/** 서재: every study room as one board on a wall, its published volumes as cloth books and its draft as a leaning proof. */
export function LibraryPage() {
  const { rooms } = useStudy();
  const readOnly = useReadOnly();
  const [lede, setLede] = useState<Lede>({ kind: "count" });
  const list = rooms ?? [];
  const fillers = Math.max(0, MIN_BOARDS - list.length - (readOnly ? 0 : 1));
  const cells = Math.max(MIN_BOARDS, list.length + (readOnly ? 0 : 1));

  return (
    <>
      <Axes on="library" />
      <div className="st-scroll">
        <div className="st-lib">
          <LedeBlock lede={lede} count={list.length} loaded={rooms !== null} />
          <div className="st-wall" style={{ height: Math.ceil(cells / 2) * 230 + 10 }}>
            <div className="st-rail" style={{ left: 0 }} />
            <div className="st-rail" style={{ left: "50%" }} />
            <div className="st-rail" style={{ left: "100%" }} />
            <div className="st-cells" role="list" aria-label="서재의 방">
              {list.map((room, k) => (
                <Board key={room.id} room={room} index={k} onHover={(on) => setLede(on ? { kind: "room", room } : { kind: "count" })} />
              ))}
              {readOnly || rooms === null ? null : <NewBoard onHover={(on) => setLede(on ? { kind: "new" } : { kind: "count" })} />}
              {Array.from({ length: fillers }, (_, i) => (
                <div key={i} className="st-cell" aria-hidden style={{ cursor: "default" }}>
                  <div className="st-board" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function LedeBlock({ lede, count, loaded }: { lede: Lede; count: number; loaded: boolean }) {
  let body: ReactNode;
  switch (lede.kind) {
    case "count":
      body = loaded ? (
        <>
          <div className="st-big">{two(count)}</div>
          <div className="st-sub">방</div>
        </>
      ) : null;
      break;
    case "room": {
      const v = latestVolume(lede.room);
      body = (
        <>
          <div className="st-kick">{lede.room.name}</div>
          {v ? (
            <div className="st-big">
              <i>v</i>
              {versionOf(v.number)}
            </div>
          ) : null}
          {v?.title ? <div className="st-sub">{v.title}</div> : null}
        </>
      );
      break;
    }
    case "new":
      body = (
        <>
          <div className="st-kick">새 방</div>
          <div className="st-big">+</div>
        </>
      );
      break;
  }
  const key = lede.kind === "room" ? lede.room.id : lede.kind;
  return (
    <div className="st-lede" aria-live="polite">
      <div key={key} className="st-swap">
        {body}
      </div>
    </div>
  );
}

function Board({ room, index, onHover }: { room: StudyRoomSummary; index: number; onHover: (on: boolean) => void }) {
  const go = useStudyGo();
  const published = room.volumes.filter((v) => v.status === "published").slice(-BOOKS_PER_BOARD);
  const draft = room.volumes.filter((v) => v.status === "draft").at(-1);
  const book = (v: StudyVolumeSummary, j: number) => {
    const size = (j + index) % WIDTHS.length;
    const label = `${room.name} v${versionOf(v.number)}`;
    const open = (e: MouseEvent) => {
      e.stopPropagation();
      go({ page: "volume", roomId: room.id, number: v.number }, e);
    };
    if (v.status === "draft") {
      return (
        <button key={v.number} type="button" className="st-bk st-proof" aria-label={label} style={{ width: 30, height: HEIGHTS[size] - 14 }} onClick={open}>
          <span className="st-spine">{room.name}</span>
          <span className="st-rib" />
        </button>
      );
    }
    const style = { width: WIDTHS[size], height: HEIGHTS[size], "--shade": `${Math.min(j, 4) * 4}%` } as CSSProperties;
    return (
      <button key={v.number} type="button" className="st-bk" aria-label={label} style={style} onClick={open}>
        <span className="st-foil" />
        <span className="st-spine">{v.title || room.name}</span>
        <span className="st-no">{v.number}</span>
      </button>
    );
  };
  return (
    <div
      role="listitem"
      className="st-cell"
      data-cloth={clothOf(room.id)}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onClick={(e) => go({ page: "room", roomId: room.id }, e)}
    >
      <div className="st-row">
        {published.map(book)}
        {draft ? book(draft, published.length) : null}
        <div className="st-end" />
      </div>
      <div className="st-board" />
      <button type="button" className="st-label" onFocus={() => onHover(true)} onBlur={() => onHover(false)}>
        {room.name}
      </button>
    </div>
  );
}

/** The empty board: "새 방", which turns into a name field and makes the room on Enter. */
function NewBoard({ onHover }: { onHover: (on: boolean) => void }) {
  const client = useClient();
  const store = useStudyStore();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setNaming(false);
    setName("");
    setError(null);
  };
  const create = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await client.createStudyRoom(name.trim());
      await store.refresh();
      close();
    } catch (e) {
      setError(errorCopy(e));
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isSubmit(e)) void create();
    else if (e.key === "Escape") close();
  };

  return (
    <div role="listitem" className="st-cell" onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)} onClick={() => setNaming(true)}>
      <div className="st-board" />
      {naming ? (
        <input
          className="st-name"
          aria-label="새 방 이름"
          placeholder="방 이름"
          autoFocus
          maxLength={60}
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => !name.trim() && close()}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <button type="button" className="st-label" onFocus={() => onHover(true)} onBlur={() => onHover(false)}>
          새 방
        </button>
      )}
      {error ? (
        <p role="alert" className="st-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
