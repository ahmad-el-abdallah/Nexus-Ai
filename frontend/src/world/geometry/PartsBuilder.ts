import {
  BoxGeometry,
  BufferGeometry,
  Color,
  type ColorRepresentation,
  CylinderGeometry,
  Euler,
  ExtrudeGeometry,
  Float32BufferAttribute,
  IcosahedronGeometry,
  Matrix4,
  Quaternion,
  type Shape,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export type Vec3 = [number, number, number];

/** Which shared material a part is rendered with. */
export type Finish = "matte" | "gloss" | "glow" | "glass";

export interface PartOptions {
  color: ColorRepresentation;
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
  finish?: Finish;
  /** Multiplier for glow parts (values above 1 feed the bloom pass). */
  intensity?: number;
  /** Faceted low-poly shading (used for foliage). */
  flat?: boolean;
}

export type BuiltParts = Partial<Record<Finish, BufferGeometry>>;

const tmpMatrix = new Matrix4();
const tmpQuat = new Quaternion();
const tmpColor = new Color();

/**
 * Assembles furniture and architecture from simple primitives, baking each
 * part's colour into a vertex attribute. Parts sharing a finish are merged,
 * so a whole piece of furniture renders as one draw call per finish — and
 * as one instanced draw call for every copy in the building.
 */
export class PartsBuilder {
  private readonly parts: Record<Finish, BufferGeometry[]> = { matte: [], gloss: [], glow: [], glass: [] };

  box(size: Vec3, opts: PartOptions & { radius?: number }): this {
    const [w, h, d] = size;
    const radius = Math.min(opts.radius ?? 0, w / 2, h / 2, d / 2);
    // Small bevels need only one segment; it keeps triangle counts low.
    const geometry = radius > 0.001 ? new RoundedBoxGeometry(w, h, d, radius > 0.05 ? 2 : 1, radius) : new BoxGeometry(w, h, d);
    return this.add(geometry, opts);
  }

  cylinder(radiusTop: number, radiusBottom: number, height: number, opts: PartOptions & { segments?: number; open?: boolean }): this {
    return this.add(new CylinderGeometry(radiusTop, radiusBottom, height, opts.segments ?? 20, 1, opts.open ?? false), opts);
  }

  sphere(radius: number, opts: PartOptions & { segments?: number }): this {
    const s = opts.segments ?? 16;
    return this.add(new SphereGeometry(radius, s, Math.max(6, Math.round(s * 0.66))), opts);
  }

  blob(radius: number, opts: PartOptions & { detail?: number }): this {
    return this.add(new IcosahedronGeometry(radius, opts.detail ?? 1), { flat: true, ...opts });
  }

  torus(radius: number, tube: number, opts: PartOptions & { arc?: number }): this {
    return this.add(new TorusGeometry(radius, tube, 8, 32, opts.arc ?? Math.PI * 2), opts);
  }

  /** Extrudes a 2D shape (drawn in x / -z) upwards by `height`. */
  extrude(shape: Shape, height: number, opts: PartOptions): this {
    const geometry = new ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 24 });
    geometry.rotateX(-Math.PI / 2);
    return this.add(geometry, opts);
  }

  /** Adds another builder's parts with an extra transform applied. */
  merge(other: PartsBuilder, position: Vec3 = [0, 0, 0], rotationY = 0): this {
    const m = new Matrix4().compose(
      new Vector3(...position),
      new Quaternion().setFromEuler(new Euler(0, rotationY, 0)),
      new Vector3(1, 1, 1),
    );
    for (const finish of Object.keys(other.parts) as Finish[]) {
      for (const g of other.parts[finish]) this.parts[finish].push(g.clone().applyMatrix4(m));
    }
    return this;
  }

  get isEmpty(): boolean {
    return Object.values(this.parts).every((list) => list.length === 0);
  }

  build(): BuiltParts {
    const out: BuiltParts = {};
    for (const finish of Object.keys(this.parts) as Finish[]) {
      const list = this.parts[finish];
      if (list.length === 0) continue;
      const merged = mergeGeometries(list, false);
      if (!merged) throw new Error(`Failed to merge ${finish} parts`);
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      out[finish] = merged;
      for (const g of list) g.dispose();
    }
    return out;
  }

  private add(source: BufferGeometry, opts: PartOptions): this {
    let geometry = source.index ? source.toNonIndexed() : source;
    if (geometry !== source) source.dispose();
    // Keep a uniform attribute set so every part can be merged.
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== "position" && name !== "normal") geometry.deleteAttribute(name);
    }
    if (opts.flat) geometry.computeVertexNormals();

    tmpQuat.setFromEuler(new Euler(...(opts.rotation ?? [0, 0, 0])));
    tmpMatrix.compose(new Vector3(...(opts.position ?? [0, 0, 0])), tmpQuat, new Vector3(...(opts.scale ?? [1, 1, 1])));
    geometry = geometry.applyMatrix4(tmpMatrix);
    if (opts.scale && opts.flat) geometry.computeVertexNormals();

    const finish = opts.finish ?? "matte";
    tmpColor.set(opts.color);
    const k = finish === "glow" ? (opts.intensity ?? 2) : 1;
    const count = geometry.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = tmpColor.r * k;
      colors[i * 3 + 1] = tmpColor.g * k;
      colors[i * 3 + 2] = tmpColor.b * k;
    }
    geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
    this.parts[finish].push(geometry);
    return this;
  }
}
