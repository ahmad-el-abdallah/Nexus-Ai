"use client";

import { useId, useMemo, useRef, useState } from "react";

import { FLOORS } from "@/world/layout/building";
import { searchRooms } from "@/world/layout/queries";
import { useOfficeStore } from "@/world/state/officeStore";

/** Search box doubling as the building directory. */
export function RoomFinder() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selectRoom = useOfficeStore((s) => s.selectRoom);
  const results = useMemo(() => searchRooms(query), [query]);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const choose = (id: string) => {
    selectRoom(id);
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  };

  return (
    <div
      className="relative w-full md:w-80"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label="Find a room or department"
        placeholder="Find a room or department…"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(results.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter" && results[active]) {
            choose(results[active].id);
          } else if (e.key === "Escape") {
            setOpen(false);
            inputRef.current?.blur();
          }
        }}
        className="h-10 w-full rounded-xl bg-nx-bg/70 px-4 text-sm text-nx-text ring-1 ring-nx-line-strong backdrop-blur-md placeholder:text-nx-faint focus:ring-nx-violet/60 focus:outline-none"
      />
      {open && (
        <ul id={listId} role="listbox" className="glass-solid absolute top-12 right-0 left-0 z-40 max-h-80 overflow-y-auto p-2">
          {results.length === 0 && <li className="px-3 py-2 text-sm text-nx-muted">No rooms match “{query}”.</li>}
          {FLOORS.slice()
            .reverse()
            .map((floor) => {
              const rooms = results.filter((r) => r.floor === floor.id);
              if (rooms.length === 0) return null;
              return (
                <li key={floor.id} role="presentation">
                  <p className="px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-nx-faint uppercase">{floor.name}</p>
                  <ul role="presentation">
                    {rooms.map((room) => {
                      const index = results.indexOf(room);
                      return (
                        <li key={room.id} role="option" aria-selected={index === active}>
                          <button
                            type="button"
                            tabIndex={-1}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => choose(room.id)}
                            onMouseEnter={() => setActive(index)}
                            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${index === active ? "bg-white/[0.06] text-nx-text" : "text-nx-muted"}`}
                          >
                            <span className="size-2 rounded-full" style={{ background: room.accent }} />
                            {room.name}
                            {room.department && <span className="ml-auto text-[11px] text-nx-faint">Department</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
        </ul>
      )}
    </div>
  );
}
