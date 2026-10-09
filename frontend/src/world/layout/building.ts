/**
 * NEXUS AI headquarters — Stage 2 layout.
 *
 * Two storeys in a stepped cutaway: the ground floor spans the full plot,
 * level 2 covers only the rear half, so the front rooms of the ground floor
 * stay visible from the isometric overview (see the office reference image).
 */

import type {
  FloorDef,
  Placement,
  Rect,
  RoomDef,
  WallDef,
  WallItemDef,
  Workstation,
} from "./types";

const rect = (x0: number, z0: number, x1: number, z1: number): Rect => ({ x0, z0, x1, z1 });
const HALF_PI = Math.PI / 2;

export const FLOORS: FloorDef[] = [
  {
    id: "L1",
    level: 1,
    name: "Ground · Lobby & Commercial",
    shortName: "Ground",
    elevation: 0,
    height: 3.6,
    footprint: rect(-16, -11, 16, 11),
  },
  {
    id: "L2",
    level: 2,
    name: "Level 2 · Executive & Engineering",
    shortName: "Level 2",
    elevation: 3.85,
    height: 3.3,
    footprint: rect(-16, -11, 16, 1),
  },
];

/** Outdoor platform the building stands on (top surface at PLINTH_TOP). */
export const PLINTH = rect(-20, -14, 20, 15.5);
export const PLINTH_TOP = -0.45;

export const ROOMS: RoomDef[] = [
  {
    id: "reception",
    name: "Reception",
    floor: "L1",
    rect: rect(-5, 1, 5, 11),
    kind: "reception",
    accent: "#2dd4bf",
    finish: "stone",
    description:
      "The entrance lobby. Visitors are welcomed here and routed to the right department.",
  },
  {
    id: "sales",
    name: "Sales",
    floor: "L1",
    rect: rect(-16, 1, -5, 11),
    kind: "department",
    department: "sales",
    accent: "#fbbf24",
    finish: "carpet",
    description:
      "Lead research, outreach drafts, proposals and pipeline tracking. Outreach always needs your approval.",
  },
  {
    id: "marketing",
    name: "Marketing",
    floor: "L1",
    rect: rect(5, 1, 16, 11),
    kind: "department",
    department: "marketing",
    accent: "#f472b6",
    finish: "carpet",
    description:
      "Market analysis, positioning, campaign plans and content calendars, with research kept separate from hypotheses.",
  },
  {
    id: "lounge",
    name: "Employee Lounge",
    floor: "L1",
    rect: rect(-16, -11, 0, 1),
    kind: "amenity",
    accent: "#34d399",
    finish: "wood",
    description: "A shared break space. Purely ambient: nothing here represents work.",
  },
  {
    id: "cafe",
    name: "Cafeteria",
    floor: "L1",
    rect: rect(0, -11, 16, 1),
    kind: "amenity",
    accent: "#fb923c",
    finish: "tile",
    description: "The company café. Purely ambient: nothing here represents work.",
  },
  {
    id: "executive",
    name: "Executive Office",
    floor: "L2",
    rect: rect(-16, -11, -7, 1),
    kind: "department",
    department: "executive",
    accent: "#a78bfa",
    finish: "wood",
    description:
      "The CEO's office. Interprets your instructions, plans strategy and delegates across departments.",
  },
  {
    id: "meeting",
    name: "Meeting Room",
    floor: "L2",
    rect: rect(-7, -11, 0, 1),
    kind: "meeting",
    accent: "#818cf8",
    finish: "carpet-indigo",
    description:
      "Structured meetings between departments with a fixed agenda, turn limits and a written transcript.",
  },
  {
    id: "engineering",
    name: "Engineering",
    floor: "L2",
    rect: rect(0, -11, 10.8, 1),
    kind: "department",
    department: "engineering",
    accent: "#22d3ee",
    finish: "carpet",
    description:
      "Software architecture, development, DevOps and AI engineering. Code execution is sandboxed and permissioned.",
  },
  {
    id: "data-center",
    name: "Data Center",
    floor: "L2",
    rect: rect(10.8, -11, 16, 1),
    kind: "infrastructure",
    accent: "#8b5cf6",
    finish: "tile",
    description:
      "The Digital Vault operations room. Its panel shows live aggregate metadata from the operational storage service; the browser explorer arrives in a later stage.",
  },
];

export const WALLS: WallDef[] = [
  // ---- Ground floor: exterior ------------------------------------------
  { id: "l1-ext-left", floor: "L1", from: [-16, -11], to: [-16, 11], kind: "exterior", cutNormal: [-1, 0], windows: true },
  { id: "l1-ext-back", floor: "L1", from: [-16, -11], to: [16, -11], kind: "exterior", cutNormal: [0, -1], windows: true },
  {
    id: "l1-ext-right",
    floor: "L1",
    from: [16, -11],
    to: [16, 11],
    kind: "exterior",
    cutNormal: [1, 0],
    windows: true,
    openings: [{ at: 9.5, width: 1.6, door: "slide-double", rooms: ["cafe"] }],
  },
  { id: "l1-ext-front-sales", floor: "L1", from: [-16, 11], to: [-5, 11], kind: "exterior", cutNormal: [0, 1], windows: true },
  {
    id: "l1-storefront",
    floor: "L1",
    from: [-5, 11],
    to: [5, 11],
    kind: "storefront",
    openings: [{ at: 5, width: 2.4, door: "slide-double", rooms: ["reception"] }],
  },
  { id: "l1-ext-front-marketing", floor: "L1", from: [5, 11], to: [16, 11], kind: "exterior", cutNormal: [0, 1], windows: true },
  // ---- Ground floor: interior ------------------------------------------
  {
    id: "l1-core",
    floor: "L1",
    from: [-16, 1],
    to: [16, 1],
    kind: "solid",
    cutNormal: [0, -1],
    openings: [
      { at: 6, width: 1.2, door: "slide", rooms: ["sales", "lounge"] },
      { at: 11.7, width: 1.1, door: "slide", rooms: ["reception", "lounge"] },
      { at: 20.3, width: 1.1, door: "slide", rooms: ["reception", "cafe"] },
      { at: 26.5, width: 1.2, door: "slide", rooms: ["marketing", "cafe"] },
    ],
  },
  {
    id: "l1-glass-sales",
    floor: "L1",
    from: [-5, 1],
    to: [-5, 11],
    kind: "glass",
    openings: [{ at: 7.5, width: 1.4, door: "slide", rooms: ["sales", "reception"] }],
  },
  {
    id: "l1-glass-marketing",
    floor: "L1",
    from: [5, 1],
    to: [5, 11],
    kind: "glass",
    openings: [{ at: 7.5, width: 1.4, door: "slide", rooms: ["marketing", "reception"] }],
  },
  {
    id: "l1-glass-cafe",
    floor: "L1",
    from: [0, -11],
    to: [0, 1],
    kind: "glass",
    openings: [{ at: 6, width: 2.2, door: "none", rooms: ["lounge", "cafe"] }],
  },
  // ---- Level 2 -----------------------------------------------------------
  { id: "l2-ext-left", floor: "L2", from: [-16, -11], to: [-16, 1], kind: "exterior", cutNormal: [-1, 0], windows: true },
  { id: "l2-ext-back", floor: "L2", from: [-16, -11], to: [16, -11], kind: "exterior", cutNormal: [0, -1], windows: true },
  {
    id: "l2-ext-right",
    floor: "L2",
    from: [16, -11],
    to: [16, 1],
    kind: "exterior",
    cutNormal: [1, 0],
    windows: true,
    openings: [{ at: 9.5, width: 1.6, door: "slide-double", rooms: ["data-center"] }],
  },
  { id: "l2-balcony", floor: "L2", from: [-16, 1], to: [16, 1], kind: "railing" },
  {
    id: "l2-glass-exec",
    floor: "L2",
    from: [-7, -11],
    to: [-7, 1],
    kind: "glass",
    openings: [{ at: 10, width: 1.2, door: "slide", rooms: ["executive", "meeting"] }],
  },
  {
    id: "l2-glass-meeting",
    floor: "L2",
    from: [0, -11],
    to: [0, 1],
    kind: "glass",
    openings: [{ at: 10, width: 1.2, door: "slide", rooms: ["meeting", "engineering"] }],
  },
  {
    id: "l2-data-center",
    floor: "L2",
    from: [10.8, -11],
    to: [10.8, 1],
    kind: "glass",
    openings: [{ at: 9.5, width: 1.4, door: "slide", rooms: ["engineering", "data-center"] }],
  },
];

/** Screens, signs and boards mounted on walls. Content is never fabricated. */
export const WALL_ITEMS: WallItemDef[] = [
  // Ground floor — front rooms face +z on the core wall.
  { id: "sign-sales", wall: "l1-core", at: 3.5, y: 2.75, width: 3.2, height: 0.7, facing: [0, 1], accent: "#fbbf24", content: { kind: "sign", title: "Sales", subtitle: "Department" } },
  { id: "board-sales", wall: "l1-ext-left", at: 18, y: 1.75, width: 3.2, height: 1.8, facing: [1, 0], accent: "#fbbf24", content: { kind: "board", title: "Sales pipeline", body: "No pipeline data yet" } },
  { id: "clock-reception", wall: "l1-core", at: 13, y: 2.25, width: 1.0, height: 0.5, facing: [0, 1], accent: "#2dd4bf", content: { kind: "clock" } },
  { id: "logo-reception", wall: "l1-core", at: 16, y: 2.2, width: 4.0, height: 1.3, facing: [0, 1], accent: "#2dd4bf", content: { kind: "logo" } },
  { id: "welcome-reception", wall: "l1-core", at: 19, y: 2.25, width: 1.0, height: 0.5, facing: [0, 1], accent: "#2dd4bf", content: { kind: "welcome" } },
  { id: "moodboard-marketing", wall: "l1-core", at: 23.6, y: 1.75, width: 3.4, height: 1.6, facing: [0, 1], accent: "#f472b6", content: { kind: "moodboard" } },
  { id: "sign-marketing", wall: "l1-core", at: 29.6, y: 2.75, width: 3.2, height: 0.7, facing: [0, 1], accent: "#f472b6", content: { kind: "sign", title: "Marketing", subtitle: "Department" } },
  // Ground floor — rear amenities.
  { id: "tv-lounge", wall: "l1-ext-left", at: 6, y: 1.6, width: 2.6, height: 1.45, facing: [1, 0], accent: "#34d399", content: { kind: "ambient" } },
  { id: "sign-lounge", wall: "l1-ext-back", at: 4.5, y: 2.75, width: 3.0, height: 0.65, facing: [0, 1], accent: "#34d399", content: { kind: "sign", title: "Lounge", subtitle: "Break space" } },
  { id: "menu-cafe", wall: "l1-ext-back", at: 23, y: 2.45, width: 2.8, height: 1.05, facing: [0, 1], accent: "#fb923c", content: { kind: "menu" } },
  // Level 2.
  { id: "sign-executive", wall: "l2-ext-back", at: 4.5, y: 2.55, width: 3.0, height: 0.65, facing: [0, 1], accent: "#a78bfa", content: { kind: "sign", title: "Executive", subtitle: "Office of the CEO" } },
  { id: "board-executive", wall: "l2-ext-left", at: 5, y: 1.65, width: 2.8, height: 1.55, facing: [1, 0], accent: "#a78bfa", content: { kind: "board", title: "Company overview", body: "No projects yet" } },
  { id: "screen-meeting", wall: "l2-ext-back", at: 12.5, y: 1.65, width: 3.2, height: 1.8, facing: [0, 1], accent: "#818cf8", content: { kind: "board", title: "Meeting room", body: "No meetings scheduled" } },
  { id: "board-engineering", wall: "l2-ext-back", at: 21, y: 1.65, width: 3.6, height: 1.8, facing: [0, 1], accent: "#22d3ee", content: { kind: "board", title: "Engineering board", body: "No tasks yet" } },
  { id: "sign-engineering", wall: "l2-ext-back", at: 25.2, y: 2.55, width: 3.0, height: 0.65, facing: [0, 1], accent: "#22d3ee", content: { kind: "sign", title: "Engineering", subtitle: "Department" } },
  { id: "sign-data-center", wall: "l2-ext-back", at: 29.2, y: 2.55, width: 3.0, height: 0.65, facing: [0, 1], accent: "#8b5cf6", content: { kind: "sign", title: "Data Center", subtitle: "Digital Vault" } },
];

// ---------------------------------------------------------------------------
// Workstations (desks an AI employee can occupy from Stage 3)
// ---------------------------------------------------------------------------

/** Four desks back-to-back; occupants face the shared privacy divider. */
function pod(room: string, floor: "L1" | "L2", cx: number, cz: number, startIndex: number, monitors: 1 | 2, columns = 2): Workstation[] {
  const out: Workstation[] = [];
  const xs = columns === 2 ? [cx - 0.8, cx + 0.8] : [cx];
  let n = startIndex;
  for (const x of xs) {
    out.push({ id: `${room}-desk-${n++}`, room, floor, x, z: cz + 0.4, rot: 0, monitors, style: "standard" });
    out.push({ id: `${room}-desk-${n++}`, room, floor, x, z: cz - 0.4, rot: Math.PI, monitors, style: "standard" });
  }
  return out;
}

export const WORKSTATIONS: Workstation[] = [
  ...pod("sales", "L1", -12.6, 6.0, 1, 1),
  ...pod("sales", "L1", -8.0, 6.0, 5, 1),
  { id: "reception-desk-1", room: "reception", floor: "L1", x: 0, z: 3.6, rot: Math.PI, monitors: 1, style: "reception" },
  ...pod("marketing", "L1", 8.6, 6.0, 1, 1),
  ...pod("marketing", "L1", 12.8, 6.0, 5, 1, 1),
  { id: "executive-desk-1", room: "executive", floor: "L2", x: -11.5, z: -7.2, rot: Math.PI, monitors: 1, style: "executive" },
  ...pod("engineering", "L2", 8.0, -4.0, 1, 2),
  ...pod("engineering", "L2", 2.3, -7.5, 5, 2),
  ...pod("engineering", "L2", 7.0, -7.5, 9, 2),
];

/** Desk and chair placements derived from a workstation. */
export function workstationPlacements(ws: Workstation): Placement[] {
  const sin = Math.sin(ws.rot);
  const cos = Math.cos(ws.rot);
  // The occupant's seat sits on the desk's local +z side.
  const seat = (d: number) => ({ x: ws.x + sin * d, z: ws.z + cos * d });
  if (ws.style === "reception") {
    const s = seat(0.85);
    return [
      { id: `${ws.id}`, type: "receptionDesk", floor: ws.floor, room: ws.room, x: ws.x, z: ws.z, rot: 0 },
      { id: `${ws.id}-chair`, type: "chair", floor: ws.floor, room: ws.room, x: s.x, z: s.z - 0.15, rot: 0 },
    ];
  }
  if (ws.style === "executive") {
    const s = seat(0.95);
    return [
      { id: `${ws.id}`, type: "execDesk", floor: ws.floor, room: ws.room, x: ws.x, z: ws.z, rot: ws.rot },
      { id: `${ws.id}-chair`, type: "execChair", floor: ws.floor, room: ws.room, x: s.x, z: s.z, rot: ws.rot + Math.PI },
    ];
  }
  const s = seat(0.78);
  return [
    { id: `${ws.id}`, type: "desk", floor: ws.floor, room: ws.room, x: ws.x, z: ws.z, rot: ws.rot },
    { id: `${ws.id}-chair`, type: "chair", floor: ws.floor, room: ws.room, x: s.x, z: s.z, rot: ws.rot + Math.PI },
  ];
}

// ---------------------------------------------------------------------------
// Furniture & decor
// ---------------------------------------------------------------------------

let decorId = 0;
const at = (
  type: Placement["type"],
  room: string | null,
  floor: "L1" | "L2",
  x: number,
  z: number,
  rot = 0,
  tint?: string,
): Placement => ({ id: `${room ?? "site"}-${type}-${++decorId}`, type, floor, room, x, z, rot, tint });

const DECOR: Placement[] = [
  // Sales
  at("armchair", "sales", "L1", -9.1, 9.6, Math.PI * 0.85, "#fbbf24"),
  at("armchair", "sales", "L1", -6.9, 9.6, -Math.PI * 0.85, "#fbbf24"),
  at("coffeeTable", "sales", "L1", -8.0, 8.6),
  at("plant", "sales", "L1", -15.3, 1.7),
  at("plantTall", "sales", "L1", -15.3, 10.3),
  at("plant", "sales", "L1", -5.8, 1.7),
  at("plantTall", "sales", "L1", -5.8, 10.3),
  // Reception
  at("sofa", "reception", "L1", -3.7, 6.6, HALF_PI, "#5eead4"),
  at("coffeeTable", "reception", "L1", -2.4, 6.6, HALF_PI),
  at("sofa", "reception", "L1", 3.7, 6.6, -HALF_PI, "#5eead4"),
  at("coffeeTable", "reception", "L1", 2.4, 6.6, HALF_PI),
  at("rug", "reception", "L1", 0, 7.2, 0, "#2dd4bf"),
  at("plantTall", "reception", "L1", -4.3, 10.3),
  at("plantTall", "reception", "L1", 4.3, 10.3),
  at("plant", "reception", "L1", -2.6, 1.6),
  at("plant", "reception", "L1", 2.6, 1.6),
  // Marketing
  at("roundTable", "marketing", "L1", 13.3, 9.3),
  at("cafeChair", "marketing", "L1", 12.4, 9.3, HALF_PI),
  at("cafeChair", "marketing", "L1", 14.2, 9.3, -HALF_PI),
  at("cafeChair", "marketing", "L1", 13.3, 10.2, Math.PI),
  at("beanbag", "marketing", "L1", 7.6, 9.6, 0, "#f472b6"),
  at("beanbag", "marketing", "L1", 9.1, 10.0, 0, "#c084fc"),
  at("plantTall", "marketing", "L1", 5.8, 10.3),
  at("plant", "marketing", "L1", 15.3, 1.7),
  at("plantTall", "marketing", "L1", 15.3, 10.3),
  at("plant", "marketing", "L1", 5.8, 1.7),
  // Lounge
  at("sofa", "lounge", "L1", -12.4, -5.0, -HALF_PI, "#6ee7b7"),
  at("coffeeTable", "lounge", "L1", -13.9, -5.0, HALF_PI),
  at("armchair", "lounge", "L1", -13.9, -7.4, 0, "#6ee7b7"),
  at("armchair", "lounge", "L1", -13.9, -2.6, Math.PI, "#6ee7b7"),
  at("rug", "lounge", "L1", -13.6, -5.0, HALF_PI, "#34d399"),
  at("floorLamp", "lounge", "L1", -11.4, -3.2),
  at("pingPong", "lounge", "L1", -6.0, -5.2),
  at("bookshelf", "lounge", "L1", -9.0, -10.55),
  at("beanbag", "lounge", "L1", -2.6, -8.9, 0, "#34d399"),
  at("beanbag", "lounge", "L1", -1.4, -8.2, 0, "#a7f3d0"),
  at("plantTall", "lounge", "L1", -15.3, -10.3),
  at("plant", "lounge", "L1", -0.7, -10.3),
  at("plant", "lounge", "L1", -15.3, 0.3),
  at("plantTall", "lounge", "L1", -6.0, 0.3),
  // Cafeteria
  at("counter", "cafe", "L1", 6.8, -10.3),
  at("fridge", "cafe", "L1", 10.9, -10.5),
  at("waterCooler", "cafe", "L1", 15.4, -10.4),
  at("pendant", "cafe", "L1", 5.0, -9.4),
  at("pendant", "cafe", "L1", 6.8, -9.4),
  at("pendant", "cafe", "L1", 8.6, -9.4),
  ...[3.6, 7.2, 10.8].flatMap((x) =>
    [-6.6, -3.2].flatMap((z) => [
      at("cafeTable", "cafe", "L1", x, z),
      at("cafeChair", "cafe", "L1", x - 0.75, z, HALF_PI),
      at("cafeChair", "cafe", "L1", x + 0.75, z, -HALF_PI),
    ]),
  ),
  at("plantTall", "cafe", "L1", 15.3, 0.3),
  at("plant", "cafe", "L1", 0.8, -10.3),
  at("plant", "cafe", "L1", 13.6, -10.3),
  // Executive office
  at("execChair", "executive", "L2", -12.1, -5.9, Math.PI, "#a78bfa"),
  at("execChair", "executive", "L2", -10.9, -5.9, Math.PI, "#a78bfa"),
  at("bookshelf", "executive", "L2", -11.5, -10.55),
  at("sofa", "executive", "L2", -12.4, -0.9, Math.PI, "#c4b5fd"),
  at("coffeeTable", "executive", "L2", -12.4, -2.2),
  at("armchair", "executive", "L2", -14.7, -2.2, HALF_PI, "#c4b5fd"),
  at("rug", "executive", "L2", -12.6, -1.9, 0, "#a78bfa"),
  at("globe", "executive", "L2", -8.0, -9.9),
  at("floorLamp", "executive", "L2", -15.3, -0.4),
  at("plantTall", "executive", "L2", -15.3, -10.3),
  at("plant", "executive", "L2", -7.8, 0.3),
  at("plantTall", "executive", "L2", -7.8, -4.0),
  // Meeting room
  at("conferenceTable", "meeting", "L2", -3.5, -5.2, HALF_PI),
  ...[-6.9, -5.8, -4.6, -3.5].flatMap((z) => [
    at("chair", "meeting", "L2", -4.55, z, HALF_PI, "#818cf8"),
    at("chair", "meeting", "L2", -2.45, z, -HALF_PI, "#818cf8"),
  ]),
  at("chair", "meeting", "L2", -3.5, -2.2, Math.PI, "#818cf8"),
  at("plantTall", "meeting", "L2", -6.3, -10.3),
  at("plantTall", "meeting", "L2", -0.7, -10.3),
  at("plant", "meeting", "L2", -6.3, 0.3),
  at("plant", "meeting", "L2", -0.7, 0.3),
  // Engineering
  at("collabTable", "engineering", "L2", 4.5, -1.6),
  at("stool", "engineering", "L2", 3.7, -0.75, Math.PI),
  at("stool", "engineering", "L2", 5.3, -0.75, Math.PI),
  at("stool", "engineering", "L2", 3.7, -2.45),
  at("stool", "engineering", "L2", 5.3, -2.45),
  at("plantTall", "engineering", "L2", 0.7, -10.3),
  at("plant", "engineering", "L2", 0.7, 0.3),
  at("plantTall", "engineering", "L2", 10.3, -10.3),
  // Data Center — fixed physical equipment. Live counts and health are shown only
  // in the backend-connected room panel, never inferred from these meshes.
  ...[12.0, 13.5, 15.0].flatMap((x) =>
    [-9.8, -8.0, -6.2, -4.4].map((z) => at("serverRack", "data-center", "L2", x, z)),
  ),
  // Outdoor site (on the plinth)
  at("gate", null, "L1", 0, 13.6),
  at("tree", null, "L1", -18.3, 13.6),
  at("tree", null, "L1", 18.3, 13.6),
  at("tree", null, "L1", -18.3, -12.4),
  at("tree", null, "L1", -18.3, 0.5),
  at("tree", null, "L1", -4.6, 13.4),
  at("tree", null, "L1", 4.6, 13.4),
  at("bollard", null, "L1", -1.9, 12.6),
  at("bollard", null, "L1", 1.9, 12.6),
  at("bollard", null, "L1", -1.9, 14.8),
  at("bollard", null, "L1", 1.9, 14.8),
];

export const PLACEMENTS: Placement[] = [...WORKSTATIONS.flatMap(workstationPlacements), ...DECOR];

/** External glass elevator on the east facade. */
export const ELEVATOR = { x0: 16.4, x1: 19.0, z0: -3.0, z1: 0.0, top: 8.6 };

/** Bounding box of everything worth framing in the overview. */
export const SITE_BOUNDS = { min: [-20, -1.2, -14] as const, max: [20, 7.6, 15.5] as const };
