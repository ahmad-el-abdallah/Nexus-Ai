/**
 * The set of employees present in the office: one controller per employee,
 * kept in sync with the roster from the backend.
 */

import type { Employee } from "@/lib/employees";

import { PLACEMENTS, WORKSTATIONS, workstationPlacements } from "../layout/building";
import { generateAppearance, type Appearance } from "./appearance";
import { CharacterController, type Seat } from "./controller";

export interface Resident {
  employee: Employee;
  /** Department accent the appearance was generated with. */
  accent?: string;
  appearance: Appearance;
  controller: CharacterController;
}

/** Desk id → the chair an occupant sits on. */
export const DESK_SEATS: ReadonlyMap<string, Seat> = new Map(
  WORKSTATIONS.map((ws) => {
    const chair = workstationPlacements(ws).find((p) => p.id.endsWith("-chair"))!;
    return [ws.id, { floor: ws.floor, x: chair.x, z: chair.z, yaw: chair.rot }];
  }),
);

/** Conference chairs, used when an employee's status is "meeting". */
export const MEETING_SEATS: Seat[] = PLACEMENTS.filter((p) => p.room === "meeting" && p.type === "chair").map((p) => ({
  floor: p.floor,
  x: p.x,
  z: p.z,
  yaw: p.rot,
}));

const MAX_BREAKS = 2;

export class OfficeWorld {
  readonly residents = new Map<string, Resident>();
  private meetingAssignments = new Map<string, Seat>();

  /**
   * Adds, updates and removes residents to match the roster. A new desk is
   * a new home: the person walks there (or arrives / leaves by elevator).
   */
  sync(employees: Employee[], accents: Record<string, string> = {}): void {
    const seen = new Set<string>();
    for (const employee of employees) {
      seen.add(employee.id);
      const home = employee.desk_id ? (DESK_SEATS.get(employee.desk_id) ?? null) : null;
      const existing = this.residents.get(employee.id);
      if (existing && existing.employee.avatar_seed === employee.avatar_seed) {
        if (existing.employee.department !== employee.department || existing.accent !== accents[employee.department]) {
          existing.appearance = generateAppearance(employee.avatar_seed, employee.department, accents[employee.department]);
          existing.accent = accents[employee.department];
        }
        if (existing.employee.desk_id !== employee.desk_id) existing.controller.home = home;
        existing.employee = employee;
        continue;
      }
      this.residents.set(employee.id, {
        employee,
        accent: accents[employee.department],
        appearance: generateAppearance(employee.avatar_seed, employee.department, accents[employee.department]),
        controller: new CharacterController(employee.id, employee.avatar_seed, home, employee.status),
      });
    }
    for (const id of [...this.residents.keys()]) if (!seen.has(id)) this.residents.delete(id);
    for (const id of [...this.meetingAssignments.keys()]) {
      if (this.residents.get(id)?.employee.status !== "meeting") this.meetingAssignments.delete(id);
    }
  }

  private meetingSeatFor(id: string): Seat | null {
    const assigned = this.meetingAssignments.get(id);
    if (assigned) return assigned;
    const taken = new Set(this.meetingAssignments.values());
    const free = MEETING_SEATS.find((s) => !taken.has(s));
    if (free) this.meetingAssignments.set(id, free);
    return free ?? null;
  }

  update(dt: number, now: number, ambient: boolean): void {
    let onBreak = 0;
    for (const r of this.residents.values()) if (r.controller.onBreak) onBreak++;
    for (const r of this.residents.values()) {
      r.controller.update(dt, {
        now,
        status: r.employee.status,
        ambient,
        requestBreak: () => {
          if (onBreak >= MAX_BREAKS) return false;
          onBreak++;
          return true;
        },
        meetingSeat: () => this.meetingSeatFor(r.employee.id),
      });
    }
  }

  get anyMoving(): boolean {
    for (const r of this.residents.values()) if (r.controller.moving) return true;
    return false;
  }
}

/** The office shared by the 3D scene, the camera and the HUD. */
export const officeWorld = new OfficeWorld();
