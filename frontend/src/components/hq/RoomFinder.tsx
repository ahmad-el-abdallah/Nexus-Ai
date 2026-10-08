"use client";

import { useId, useMemo, useRef, useState } from "react";

import { FLOORS } from "@/world/layout/building";
import { searchRooms } from "@/world/layout/queries";
import { useEmployeeStore } from "@/world/state/employeeStore";
import { useOfficeStore } from "@/world/state/officeStore";

import { useDepartmentStore } from "@/world/state/departmentStore";

import { departmentMeta, Initials } from "./people";

/** Search box doubling as the building directory (rooms and people). */
export function RoomFinder() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selectRoom = useOfficeStore((s) => s.selectRoom);
  const selectEmployee = useOfficeStore((s) => s.selectEmployee);
  const employees = useEmployeeStore((s) => s.employees);
  const departments = useDepartmentStore((s) => s.departments);
  const rooms = useMemo(() => searchRooms(query), [query]);
  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return employees.filter((e) =>
      [e.name, e.role, departmentMeta(e.department, departments).name].some((f) => f.toLowerCase().includes(q)),
    );
  }, [employees, departments, query]);
  type Result = { kind: "room"; id: string } | { kind: "person"; id: string };
  const results: Result[] = [...people.map((p) => ({ kind: "person" as const, id: p.id })), ...rooms.map((r) => ({ kind: "room" as const, id: r.id }))];
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const choose = (result: Result) => {
    if (result.kind === "room") selectRoom(result.id);
    else selectEmployee(result.id);
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
        aria-label="Find a room, department or employee"
        placeholder="Find a room, department or person…"
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
            choose(results[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
            inputRef.current?.blur();
          }
        }}
        className="h-10 w-full rounded-xl bg-nx-bg/70 px-4 text-sm text-nx-text ring-1 ring-nx-line-strong backdrop-blur-md placeholder:text-nx-faint focus:ring-nx-violet/60 focus:outline-none"
      />
      {open && (
        <ul id={listId} role="listbox" className="glass-solid absolute top-12 right-0 left-0 z-40 max-h-80 overflow-y-auto p-2">
          {results.length === 0 && <li className="px-3 py-2 text-sm text-nx-muted">Nothing matches “{query}”.</li>}
          {people.length > 0 && (
            <li role="presentation">
              <p className="px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-nx-faint uppercase">People</p>
              <ul role="presentation">
                {people.map((p, index) => (
                  <li key={p.id} role="option" aria-selected={index === active}>
                    <button
                      type="button"
                      tabIndex={-1}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose({ kind: "person", id: p.id })}
                      onMouseEnter={() => setActive(index)}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${index === active ? "bg-white/[0.06] text-nx-text" : "text-nx-muted"}`}
                    >
                      <Initials employee={p} size="size-6" />
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      <span className="truncate text-[11px] text-nx-faint">{p.role}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          )}
          {FLOORS.slice()
            .reverse()
            .map((floor) => {
              const floorRooms = rooms.filter((r) => r.floor === floor.id);
              if (floorRooms.length === 0) return null;
              return (
                <li key={floor.id} role="presentation">
                  <p className="px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-nx-faint uppercase">{floor.name}</p>
                  <ul role="presentation">
                    {floorRooms.map((room) => {
                      const index = people.length + rooms.indexOf(room);
                      return (
                        <li key={room.id} role="option" aria-selected={index === active}>
                          <button
                            type="button"
                            tabIndex={-1}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => choose({ kind: "room", id: room.id })}
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
