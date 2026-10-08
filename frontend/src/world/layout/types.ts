/**
 * Data model for the headquarters layout. Coordinates are metres in a
 * right-handed, y-up world centred on the building: x runs left → right,
 * z runs back → front (the entrance faces +z).
 */

export type FloorId = "L1" | "L2";
export type ActiveFloor = FloorId | "all";

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface FloorDef {
  id: FloorId;
  level: number;
  name: string;
  shortName: string;
  /** Height of the finished floor surface. */
  elevation: number;
  /** Clear wall height of this storey. */
  height: number;
  footprint: Rect;
}

/** Stable department keys; Stage 4 creates matching backend departments. */
export type DepartmentKey = "executive" | "sales" | "marketing" | "engineering";

export type RoomKind = "department" | "meeting" | "reception" | "amenity";

export type FloorFinish = "carpet" | "carpet-indigo" | "stone" | "wood" | "tile";

export interface RoomDef {
  id: string;
  name: string;
  floor: FloorId;
  rect: Rect;
  kind: RoomKind;
  department?: DepartmentKey;
  /** Department / room identity colour (hex). */
  accent: string;
  finish: FloorFinish;
  description: string;
}

export type DoorKind = "slide" | "slide-double" | "none";

export interface Opening {
  /** Distance along the wall from its `from` point to the opening centre. */
  at: number;
  width: number;
  door: DoorKind;
  /** Rooms whose hover/selection opens the door. */
  rooms: string[];
}

export type WallKind = "exterior" | "solid" | "glass" | "storefront" | "railing";

export interface WallDef {
  id: string;
  floor: FloorId;
  from: [number, number];
  to: [number, number];
  kind: WallKind;
  /**
   * Outward direction used for camera cutaway: the wall is cut down whenever
   * the camera looks at it from this side. Omitted for see-through walls.
   */
  cutNormal?: [number, number];
  windows?: boolean;
  openings?: Opening[];
}

export type WallItemContent =
  | { kind: "sign"; title: string; subtitle: string }
  | { kind: "logo" }
  | { kind: "clock" }
  | { kind: "welcome" }
  | { kind: "board"; title: string; body: string }
  | { kind: "moodboard" }
  | { kind: "menu" }
  | { kind: "ambient" };

export interface WallItemDef {
  id: string;
  wall: string;
  /** Distance along the wall from its `from` point to the item centre. */
  at: number;
  /** Centre height above the floor. */
  y: number;
  width: number;
  height: number;
  /** Direction the item faces (unit vector on the xz plane). */
  facing: [number, number];
  accent: string;
  content: WallItemContent;
}

export type FurnitureType =
  | "desk"
  | "chair"
  | "execDesk"
  | "execChair"
  | "receptionDesk"
  | "plant"
  | "plantTall"
  | "tree"
  | "sofa"
  | "armchair"
  | "coffeeTable"
  | "roundTable"
  | "cafeTable"
  | "cafeChair"
  | "stool"
  | "collabTable"
  | "conferenceTable"
  | "bookshelf"
  | "serverRack"
  | "pingPong"
  | "beanbag"
  | "counter"
  | "fridge"
  | "waterCooler"
  | "floorLamp"
  | "globe"
  | "rug"
  | "pendant"
  | "gate"
  | "bollard";

export interface Placement {
  id: string;
  type: FurnitureType;
  floor: FloorId;
  /** Owning room, or null for the outdoor site. */
  room: string | null;
  x: number;
  z: number;
  /** Rotation about y (radians). Local +z is the item's front. */
  rot: number;
  /** Optional tint multiplied into the item's light-coloured parts. */
  tint?: string;
}

/** A desk that an AI employee can be assigned to (Stage 3). */
export interface Workstation {
  id: string;
  room: string;
  floor: FloorId;
  x: number;
  z: number;
  /** Desk rotation; the occupant sits on the desk's local +z side. */
  rot: number;
  monitors: 1 | 2;
  style: "standard" | "executive" | "reception";
}
