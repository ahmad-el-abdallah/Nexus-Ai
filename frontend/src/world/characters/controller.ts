/**
 * Behaviour of one employee in the office. The employee's real status picks
 * the destination (desk, meeting seat, or away); the controller only works
 * out how to get there. Ambient breaks are decorative, optional and never
 * change the status the owner sees.
 */

import type { EmployeeStatus } from "@/lib/employees";

import { FLOOR_BY_ID } from "../layout/queries";
import type { FloorId } from "../layout/types";
import { AMBIENT_SPOTS, ELEVATOR_SPOT, navGrid, type Point } from "./navigation";
import { activityPose, blendPose, type Pose, walkPose } from "./rig";
import { STATUS_META } from "./status";

export interface Seat {
  floor: FloorId;
  x: number;
  z: number;
  /** Facing of a seated person (chair front). */
  yaw: number;
}

export type Mode = "seated" | "standing" | "walking" | "sittingDown" | "standingUp" | "fadingOut" | "fadingIn" | "away";

type Goal =
  | { kind: "seat"; seat: Seat }
  | { kind: "spot"; floor: FloorId; x: number; z: number; yaw: number; label: string }
  | { kind: "away" };

const WALK_SPEED = 1.25;
const STRIDE = 1.3;
const SIT_TIME = 0.7;
const FADE_TIME = 0.6;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standing spot behind a chair, from which a person sits down. */
export function approachPoint(seat: Seat): Point {
  return { x: seat.x - Math.sin(seat.yaw) * 0.6, z: seat.z - Math.cos(seat.yaw) * 0.6 };
}

const angleDelta = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

export interface UpdateContext {
  now: number;
  status: EmployeeStatus;
  ambient: boolean;
  /** Returns true if this employee may start an ambient break now. */
  requestBreak: () => boolean;
  meetingSeat: () => Seat | null;
}

export class CharacterController {
  floor: FloorId;
  x: number;
  z: number;
  yaw: number;
  mode: Mode;
  opacity = 1;
  /** Human-readable description of what the avatar is doing (shown in the HUD). */
  doing = "At desk";
  onBreak = false;
  walkPhase = 0;

  private goal: Goal;
  private path: Point[] = [];
  private pathIndex = 0;
  private transition = 0;
  private sitFrom: Point = { x: 0, z: 0 };
  /** The seat currently occupied (while seated or getting up). */
  private occupied: Seat | null = null;
  /** The seat being sat down on. */
  private sitTarget: Seat | null = null;
  private sitFromYaw = 0;
  private pendingFloor: FloorId | null = null;
  private breakUntil = 0;
  private nextBreakAt: number;
  private readonly rand: () => number;

  constructor(
    readonly id: string,
    readonly seed: number,
    readonly home: Seat | null,
    status: EmployeeStatus,
  ) {
    this.rand = mulberry32(seed);
    // Scheduled on the first update (relative to the clock it provides).
    this.nextBreakAt = -1;
    // Spawn already in place: page loads never show people walking in.
    const meta = STATUS_META[status];
    if (meta.location === "away" || !home) {
      this.floor = home?.floor ?? "L1";
      this.x = ELEVATOR_SPOT.x;
      this.z = ELEVATOR_SPOT.z;
      this.yaw = -Math.PI / 2;
      this.mode = "away";
      this.opacity = 0;
      this.goal = { kind: "away" };
      this.doing = home ? "Away" : "No desk in this building";
    } else {
      this.floor = home.floor;
      this.x = home.x;
      this.z = home.z;
      this.yaw = home.yaw;
      this.mode = "seated";
      this.goal = { kind: "seat", seat: home };
      this.occupied = home;
    }
  }

  get visible(): boolean {
    return this.mode !== "away";
  }

  get moving(): boolean {
    return this.mode !== "seated" && this.mode !== "standing" && this.mode !== "away";
  }

  get elevation(): number {
    return FLOOR_BY_ID.get(this.floor)!.elevation;
  }

  private desiredGoal(ctx: UpdateContext): Goal {
    if (this.nextBreakAt < 0) this.nextBreakAt = ctx.now + 45 + this.rand() * 150;
    const meta = STATUS_META[ctx.status];
    if (meta.location === "away" || !this.home) return { kind: "away" };
    if (meta.location === "meeting") {
      const seat = ctx.meetingSeat();
      if (seat) return { kind: "seat", seat };
    }
    // Ambient breaks: only for idle employees, only when enabled.
    if (ctx.status === "idle" && ctx.ambient) {
      if (this.onBreak && ctx.now < this.breakUntil && this.goal.kind === "spot") return this.goal;
      if (!this.onBreak && this.mode === "seated" && ctx.now >= this.nextBreakAt) {
        this.nextBreakAt = ctx.now + 90 + this.rand() * 240;
        const spots = AMBIENT_SPOTS[this.home.floor];
        if (spots.length && ctx.requestBreak()) {
          const spot = spots[Math.floor(this.rand() * spots.length)];
          this.onBreak = true;
          this.breakUntil = ctx.now + 15 + this.rand() * 25;
          return { kind: "spot", floor: this.home.floor, ...spot };
        }
      }
    }
    this.onBreak = false;
    return { kind: "seat", seat: this.home };
  }

  private sameGoal(a: Goal, b: Goal): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === "seat" && b.kind === "seat") return a.seat === b.seat;
    if (a.kind === "spot" && b.kind === "spot") return a.x === b.x && a.z === b.z;
    return true;
  }

  private goalTarget(goal: Goal): { floor: FloorId; point: Point } {
    if (goal.kind === "seat") return { floor: goal.seat.floor, point: approachPoint(goal.seat) };
    if (goal.kind === "spot") return { floor: goal.floor, point: { x: goal.x, z: goal.z } };
    return { floor: this.floor, point: ELEVATOR_SPOT };
  }

  /** Plans the next leg: either straight to the goal or to the elevator first. */
  private planLeg() {
    const target = this.goalTarget(this.goal);
    const crossFloor = this.goal.kind !== "away" && target.floor !== this.floor;
    const destination = crossFloor ? ELEVATOR_SPOT : target.point;
    this.pendingFloor = crossFloor ? target.floor : null;
    const path = navGrid(this.floor).findPath({ x: this.x, z: this.z }, destination);
    this.path = path ?? [{ x: this.x, z: this.z }, destination];
    this.pathIndex = 1;
    this.mode = "walking";
  }

  update(dt: number, ctx: UpdateContext): void {
    const goal = this.desiredGoal(ctx);
    if (!this.sameGoal(goal, this.goal)) {
      this.goal = goal;
      if (this.mode === "seated") {
        this.mode = "standingUp";
        this.transition = 0;
      } else if (this.mode === "away") {
        // Re-enter through the elevator on the destination floor.
        const target = this.goalTarget(goal);
        this.floor = target.floor;
        this.x = ELEVATOR_SPOT.x;
        this.z = ELEVATOR_SPOT.z;
        this.mode = "fadingIn";
        this.transition = 0;
      } else if (this.mode === "walking" || this.mode === "standing" || this.mode === "sittingDown") {
        this.planLeg();
      }
    }

    switch (this.mode) {
      case "standingUp": {
        // Slide back out from the desk while standing up, then walk.
        this.transition = Math.min(1, this.transition + dt / SIT_TIME);
        if (this.occupied) {
          const back = approachPoint(this.occupied);
          this.x = this.occupied.x + (back.x - this.occupied.x) * this.transition;
          this.z = this.occupied.z + (back.z - this.occupied.z) * this.transition;
        }
        if (this.transition >= 1) {
          this.occupied = null;
          this.planLeg();
        }
        break;
      }
      case "walking": {
        let remaining = WALK_SPEED * dt;
        while (remaining > 0 && this.pathIndex < this.path.length) {
          const wp = this.path[this.pathIndex];
          const dx = wp.x - this.x;
          const dz = wp.z - this.z;
          const d = Math.hypot(dx, dz);
          if (d < 1e-4) {
            this.pathIndex++;
            continue;
          }
          const step = Math.min(d, remaining);
          this.x += (dx / d) * step;
          this.z += (dz / d) * step;
          this.walkPhase += (step / STRIDE) * Math.PI * 2;
          remaining -= step;
          const heading = Math.atan2(dx, dz);
          this.yaw += angleDelta(this.yaw, heading) * Math.min(1, dt * 10);
          if (step >= d) this.pathIndex++;
        }
        if (this.pathIndex >= this.path.length) this.arrive();
        break;
      }
      case "sittingDown": {
        this.transition = Math.min(1, this.transition + dt / SIT_TIME);
        const seat = this.sitTarget!;
        const k = this.transition;
        this.x = this.sitFrom.x + (seat.x - this.sitFrom.x) * k;
        this.z = this.sitFrom.z + (seat.z - this.sitFrom.z) * k;
        this.yaw = this.sitFromYaw + angleDelta(this.sitFromYaw, seat.yaw) * k;
        if (this.transition >= 1) {
          this.mode = "seated";
          this.occupied = seat;
        }
        break;
      }
      case "standing": {
        if (this.goal.kind === "spot") this.yaw += angleDelta(this.yaw, this.goal.yaw) * Math.min(1, dt * 4);
        break;
      }
      case "fadingOut": {
        this.transition += dt / FADE_TIME;
        this.opacity = Math.max(0, 1 - this.transition);
        if (this.transition >= 1) {
          if (this.pendingFloor) {
            this.floor = this.pendingFloor;
            this.pendingFloor = null;
            this.mode = "fadingIn";
            this.transition = 0;
          } else if (this.goal.kind === "away") {
            this.mode = "away";
          } else {
            // The goal changed while leaving (e.g. re-activated): come straight back.
            this.floor = this.goalTarget(this.goal).floor;
            this.mode = "fadingIn";
            this.transition = 0;
          }
        }
        break;
      }
      case "fadingIn": {
        this.transition += dt / FADE_TIME;
        this.opacity = Math.min(1, this.transition);
        if (this.transition >= 1) {
          this.opacity = 1;
          this.planLeg();
        }
        break;
      }
      case "seated":
      case "away":
        break;
    }
    this.doing = this.describe(ctx.status);
  }

  private arrive() {
    const target = this.goalTarget(this.goal);
    if (this.pendingFloor || this.goal.kind === "away") {
      // At the elevator: leave this floor (or the building).
      this.mode = "fadingOut";
      this.transition = 0;
      return;
    }
    if (target.floor !== this.floor) return this.planLeg();
    if (this.goal.kind === "seat") {
      this.mode = "sittingDown";
      this.sitTarget = this.goal.seat;
      this.transition = 0;
      this.sitFrom = { x: this.x, z: this.z };
      this.sitFromYaw = this.yaw;
    } else {
      this.mode = "standing";
    }
  }

  private describe(status: EmployeeStatus): string {
    switch (this.mode) {
      case "away":
        return this.home ? "Away (not in the office)" : "No desk in this building";
      case "fadingOut":
        return this.goal.kind === "away" ? "Leaving the office" : "Taking the elevator";
      case "fadingIn":
        return "Arriving by elevator";
      case "walking":
        return this.goal.kind === "away" ? "Leaving the office" : this.onBreak ? "Walking to a break (ambient)" : "Walking to desk";
      case "standing":
        return this.goal.kind === "spot" ? `On a break at the ${this.goal.label} (ambient)` : "Standing";
      case "standingUp":
      case "sittingDown":
        return "Moving";
      case "seated":
        return this.goal.kind === "seat" && this.goal.seat !== this.home ? "In the meeting room" : STATUS_META[status].location === "desk" ? "At desk" : "Seated";
    }
  }

  /** Target pose for this frame (before smoothing). */
  pose(t: number, status: EmployeeStatus): Pose {
    const meta = STATUS_META[status];
    const seatedActivity = meta.activity === "standIdle" ? "sitIdle" : meta.activity;
    const seatedPose = () => {
      if (seatedActivity !== "celebrate") return activityPose(seatedActivity, t, this.seed);
      const p = activityPose("sitIdle", t, this.seed);
      p.armL = [0.2, 2.5, 0];
      p.armR = [0.2, 2.5, 0];
      p.elbowL = 0.3;
      p.elbowR = 0.3;
      return p;
    };
    switch (this.mode) {
      case "seated":
        return seatedPose();
      case "walking":
        return walkPose(this.walkPhase);
      case "standingUp":
        return blendPose(seatedPose(), activityPose("standIdle", t, this.seed), Math.min(1, this.transition));
      case "sittingDown":
        return blendPose(activityPose("standIdle", t, this.seed), seatedPose(), this.transition);
      default:
        return activityPose("standIdle", t, this.seed);
    }
  }
}
