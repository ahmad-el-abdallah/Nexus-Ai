/**
 * Procedural character rig. A character is a hierarchy of rigid parts
 * (pelvis → torso → head / arms, pelvis → legs) driven by joint angles.
 * Poses are plain numbers, so they blend, test and animate cheaply, and the
 * resulting part matrices feed instanced meshes shared by every employee.
 *
 * Conventions: the character faces local +z, its left is +x. A positive
 * "swing" moves a limb forward (rotation about x is negated internally).
 */

import { Euler, Matrix4, Quaternion, Vector3 } from "three";

import type { Activity } from "./status";

export const RIG = {
  hipHeight: 0.9,
  pelvisToTorso: 0.08,
  torsoLength: 0.48,
  shoulderY: 0.42,
  shoulderX: 0.205,
  upperArm: 0.28,
  forearm: 0.25,
  hipX: 0.085,
  thigh: 0.42,
  shin: 0.41,
  /** Seat height for office chairs (top of cushion). */
  seatHeight: 0.52,
} as const;

export interface Pose {
  pelvisY: number;
  pelvisZ: number;
  pelvisPitch: number;
  spinePitch: number;
  spineYaw: number;
  spineRoll: number;
  neckPitch: number;
  neckYaw: number;
  /** Arms: [swing forward, raise sideways, twist] */
  armL: [number, number, number];
  armR: [number, number, number];
  elbowL: number;
  elbowR: number;
  /** Legs: [swing forward, sideways] */
  legL: [number, number];
  legR: [number, number];
  kneeL: number;
  kneeR: number;
}

const base = (): Pose => ({
  pelvisY: RIG.hipHeight,
  pelvisZ: 0,
  pelvisPitch: 0,
  spinePitch: 0,
  spineYaw: 0,
  spineRoll: 0,
  neckPitch: 0,
  neckYaw: 0,
  armL: [0, 0.08, 0],
  armR: [0, 0.08, 0],
  elbowL: 0.15,
  elbowR: 0.15,
  legL: [0, 0],
  legR: [0, 0],
  kneeL: 0,
  kneeR: 0,
});

/** Smooth pseudo-noise in [-1, 1] for natural idle variation. */
function wobble(t: number, seed: number): number {
  return Math.sin(t * 0.37 + seed) * 0.6 + Math.sin(t * 0.91 + seed * 1.7) * 0.4;
}

function seated(p: Pose): Pose {
  p.pelvisY = RIG.seatHeight;
  p.pelvisZ = -0.06;
  p.legL = [Math.PI / 2 - 0.08, 0.06];
  p.legR = [Math.PI / 2 - 0.08, 0.06];
  p.kneeL = Math.PI / 2 - 0.05;
  p.kneeR = Math.PI / 2 - 0.05;
  return p;
}

/** Target pose for an activity at time t (seconds); `seed` desynchronises people. */
export function activityPose(activity: Activity, t: number, seed: number): Pose {
  const p = base();
  const breathe = Math.sin(t * 1.6 + seed) * 0.015;
  switch (activity) {
    case "standIdle": {
      p.spinePitch = breathe;
      p.neckYaw = wobble(t * 0.5, seed) * 0.35;
      p.pelvisY = RIG.hipHeight - 0.005 + Math.sin(t * 0.8 + seed) * 0.004;
      p.armL = [0.05, 0.1, 0];
      p.armR = [0.05, 0.1, 0];
      return p;
    }
    case "sitIdle": {
      seated(p);
      p.spinePitch = -0.06 + breathe;
      p.neckYaw = wobble(t * 0.4, seed) * 0.45;
      p.neckPitch = 0.05;
      p.armL = [0.55, 0.12, 0];
      p.armR = [0.55, 0.12, 0];
      p.elbowL = 0.9;
      p.elbowR = 0.9;
      return p;
    }
    case "sitTyping": {
      seated(p);
      p.spinePitch = 0.12 + breathe;
      p.neckPitch = 0.18;
      p.neckYaw = Math.sin(t * 0.3 + seed) * 0.08;
      const tapL = Math.max(0, Math.sin(t * 13 + seed)) * 0.08;
      const tapR = Math.max(0, Math.sin(t * 13 + seed + 2.1)) * 0.08;
      p.armL = [0.75 + tapL, 0.18, 0];
      p.armR = [0.75 + tapR, 0.18, 0];
      p.elbowL = 1.05 - tapL;
      p.elbowR = 1.05 - tapR;
      return p;
    }
    case "sitThinking": {
      seated(p);
      p.spinePitch = 0.05 + breathe;
      p.neckPitch = -0.08;
      p.neckYaw = 0.25 + wobble(t * 0.3, seed) * 0.1;
      p.armL = [0.6, 0.15, 0];
      p.elbowL = 1.0;
      p.armR = [1.05, 0.25, 0];
      p.elbowR = 2.35;
      return p;
    }
    case "sitTalking": {
      seated(p);
      p.spinePitch = 0.04 + breathe;
      p.neckYaw = Math.sin(t * 0.5 + seed) * 0.5;
      const gesture = Math.max(0, Math.sin(t * 1.3 + seed));
      p.armL = [0.6, 0.15, 0];
      p.elbowL = 0.95;
      p.armR = [0.7 + gesture * 0.5, 0.2 + gesture * 0.2, 0];
      p.elbowR = 1.0 + gesture * 0.5;
      return p;
    }
    case "sitReviewing": {
      seated(p);
      p.spinePitch = -0.15 + breathe;
      p.neckPitch = 0.12 + Math.sin(t * 0.7 + seed) * 0.06;
      p.armL = [0.35, -0.05, 0];
      p.armR = [0.35, -0.05, 0];
      p.elbowL = 1.9;
      p.elbowR = 1.9;
      return p;
    }
    case "sitSlumped": {
      seated(p);
      p.spinePitch = 0.28 + breathe;
      p.neckPitch = 0.45;
      p.armL = [0.45, 0.1, 0];
      p.armR = [0.45, 0.1, 0];
      p.elbowL = 0.7;
      p.elbowR = 0.7;
      return p;
    }
    case "celebrate": {
      const bounce = Math.abs(Math.sin(t * 6)) * 0.06;
      p.pelvisY = RIG.hipHeight + bounce;
      p.spinePitch = -0.1;
      p.neckPitch = -0.2;
      p.armL = [0.2, 2.6, 0];
      p.armR = [0.2, 2.6, 0];
      p.elbowL = 0.3;
      p.elbowR = 0.3;
      return p;
    }
  }
}

/** Walk cycle; `phase` advances with distance travelled (one cycle ≈ 1.3 m). */
export function walkPose(phase: number): Pose {
  const p = base();
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  p.legL = [s * 0.45, 0];
  p.legR = [-s * 0.45, 0];
  p.kneeL = Math.max(0, -c) * 0.75 + 0.05;
  p.kneeR = Math.max(0, c) * 0.75 + 0.05;
  p.armL = [-s * 0.4, 0.08, 0];
  p.armR = [s * 0.4, 0.08, 0];
  p.elbowL = 0.35 + Math.max(0, -s) * 0.3;
  p.elbowR = 0.35 + Math.max(0, s) * 0.3;
  p.pelvisY = RIG.hipHeight - 0.03 + Math.abs(c) * 0.03;
  p.spinePitch = 0.04;
  p.spineYaw = s * 0.08;
  return p;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerp3 = (a: [number, number, number], b: [number, number, number], k: number): [number, number, number] => [
  lerp(a[0], b[0], k),
  lerp(a[1], b[1], k),
  lerp(a[2], b[2], k),
];
const lerp2 = (a: [number, number], b: [number, number], k: number): [number, number] => [lerp(a[0], b[0], k), lerp(a[1], b[1], k)];

/** Blends `from` toward `to` by k (0..1). */
export function blendPose(from: Pose, to: Pose, k: number): Pose {
  return {
    pelvisY: lerp(from.pelvisY, to.pelvisY, k),
    pelvisZ: lerp(from.pelvisZ, to.pelvisZ, k),
    pelvisPitch: lerp(from.pelvisPitch, to.pelvisPitch, k),
    spinePitch: lerp(from.spinePitch, to.spinePitch, k),
    spineYaw: lerp(from.spineYaw, to.spineYaw, k),
    spineRoll: lerp(from.spineRoll, to.spineRoll, k),
    neckPitch: lerp(from.neckPitch, to.neckPitch, k),
    neckYaw: lerp(from.neckYaw, to.neckYaw, k),
    armL: lerp3(from.armL, to.armL, k),
    armR: lerp3(from.armR, to.armR, k),
    elbowL: lerp(from.elbowL, to.elbowL, k),
    elbowR: lerp(from.elbowR, to.elbowR, k),
    legL: lerp2(from.legL, to.legL, k),
    legR: lerp2(from.legR, to.legR, k),
    kneeL: lerp(from.kneeL, to.kneeL, k),
    kneeR: lerp(from.kneeR, to.kneeR, k),
  };
}

export const restPose = base;

// ---------------------------------------------------------------------------
// Joint matrices
// ---------------------------------------------------------------------------

export type Joint =
  | "pelvis"
  | "torso"
  | "head"
  | "upperArmL"
  | "upperArmR"
  | "forearmL"
  | "forearmR"
  | "handL"
  | "handR"
  | "thighL"
  | "thighR"
  | "shinL"
  | "shinR"
  | "footL"
  | "footR";

export type JointMatrices = Record<Joint, Matrix4>;

const _q = new Quaternion();
const _e = new Euler();
const _v = new Vector3();
const _s = new Vector3();
const _one = new Vector3(1, 1, 1);
const _local = new Matrix4();
const _root = new Matrix4();

const JOINTS: Joint[] = ["pelvis", "torso", "head", "upperArmL", "upperArmR", "forearmL", "forearmR", "handL", "handR", "thighL", "thighR", "shinL", "shinR", "footL", "footR"];

export function createJointMatrices(): JointMatrices {
  return Object.fromEntries(JOINTS.map((j) => [j, new Matrix4()])) as JointMatrices;
}

/** out = parent × local(translation, rotation). Allocation-free. */
function chain(out: Matrix4, parent: Matrix4, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): Matrix4 {
  _e.set(rx, ry, rz, "YXZ");
  _local.compose(_v.set(x, y, z), _q.setFromEuler(_e), _one);
  return out.multiplyMatrices(parent, _local);
}

/**
 * World matrices of every joint for a character at (x, y, z) facing `yaw`.
 * Pass `out` to reuse matrices across frames (the renderer does).
 */
export function jointMatrices(
  pose: Pose,
  x: number,
  y: number,
  z: number,
  yaw: number,
  scale: number,
  build: number,
  out: JointMatrices = createJointMatrices(),
): JointMatrices {
  _root.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(0, yaw, 0)), _s.set(scale, scale, scale));
  const j = out;
  chain(j.pelvis, _root, 0, pose.pelvisY, pose.pelvisZ, -pose.pelvisPitch);
  chain(j.torso, j.pelvis, 0, RIG.pelvisToTorso, 0, -pose.spinePitch, pose.spineYaw, pose.spineRoll);
  chain(j.head, j.torso, 0, RIG.torsoLength, 0, -pose.neckPitch, pose.neckYaw, 0);
  const sx = RIG.shoulderX * build;
  chain(j.upperArmL, j.torso, sx, RIG.shoulderY, 0, -pose.armL[0], pose.armL[2], pose.armL[1]);
  chain(j.upperArmR, j.torso, -sx, RIG.shoulderY, 0, -pose.armR[0], -pose.armR[2], -pose.armR[1]);
  chain(j.forearmL, j.upperArmL, 0, -RIG.upperArm, 0, -pose.elbowL);
  chain(j.forearmR, j.upperArmR, 0, -RIG.upperArm, 0, -pose.elbowR);
  chain(j.handL, j.forearmL, 0, -RIG.forearm, 0);
  chain(j.handR, j.forearmR, 0, -RIG.forearm, 0);
  const hx = RIG.hipX * build;
  chain(j.thighL, j.pelvis, hx, -0.02, 0, -pose.legL[0], 0, pose.legL[1]);
  chain(j.thighR, j.pelvis, -hx, -0.02, 0, -pose.legR[0], 0, -pose.legR[1]);
  chain(j.shinL, j.thighL, 0, -RIG.thigh, 0, pose.kneeL);
  chain(j.shinR, j.thighR, 0, -RIG.thigh, 0, pose.kneeR);
  // Feet stay level-ish: undo most of the leg rotation at the ankle.
  chain(j.footL, j.shinL, 0, -RIG.shin, 0, pose.legL[0] - pose.kneeL);
  chain(j.footR, j.shinR, 0, -RIG.shin, 0, pose.legR[0] - pose.kneeR);
  return j;
}
