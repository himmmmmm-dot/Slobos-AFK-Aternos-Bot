import { boxFree, footprintTop, overlapsXZ, type CollisionWorld } from '../shared/collision';
import { distanceXZ, lerp, type Rng, type Vec3 } from '../shared/math';

export interface NavNode {
  id: number;
  x: number;
  y: number;
  z: number;
  links: number[];
  /** Connected-component id; two nodes with different ids can never reach each other. */
  comp: number;
  cx: number;
  cz: number;
}

export interface NavBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface NavOptions {
  cell: number;
  radius: number;
  height: number;
  stepHeight: number;
}

export const DEFAULT_NAV: NavOptions = { cell: 0.5, radius: 0.4, height: 1.9, stepHeight: 0.5 };

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  clear(): void {
    this.ids.length = 0;
    this.keys.length = 0;
  }

  push(id: number, key: number): void {
    const ids = this.ids;
    const keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      ids[i] = ids[parent];
      keys[i] = keys[parent];
      i = parent;
    }
    ids[i] = id;
    keys[i] = key;
  }

  pop(): number {
    const ids = this.ids;
    const keys = this.keys;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let child = i * 2 + 1;
        if (child >= n) break;
        if (child + 1 < n && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= lastKey) break;
        ids[i] = ids[child];
        keys[i] = keys[child];
        i = child;
      }
      ids[i] = lastId;
      keys[i] = lastKey;
    }
    return top;
  }
}

/**
 * Walkable graph derived from the collision world, so AI can go wherever a character can walk
 * (floors, ramps, stairs and stacked levels) without hand-placed waypoints.
 */
export class NavGrid {
  nodes: NavNode[] = [];
  cols = 0;
  rows = 0;
  private cells: number[][] = [];
  private g = new Float32Array(0);
  private from = new Int32Array(0);
  private seen = new Uint32Array(0);
  private closed = new Uint32Array(0);
  private search = 0;
  private heap = new MinHeap();

  private constructor(
    readonly world: CollisionWorld,
    readonly bounds: NavBounds,
    readonly opts: NavOptions,
  ) {}

  /** Seeds mark the areas that matter; anything not reachable from one is discarded. */
  static build(world: CollisionWorld, bounds: NavBounds, seeds: Vec3[], opts: NavOptions = DEFAULT_NAV): NavGrid {
    const nav = new NavGrid(world, bounds, opts);
    const { cell, radius, height, stepHeight } = opts;
    const cols = (nav.cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cell)));
    const rows = (nav.rows = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / cell)));
    const nodes: NavNode[] = [];
    const cells: number[][] = new Array(cols * rows);
    const tops: number[] = [];
    for (let cz = 0; cz < rows; cz++) {
      for (let cx = 0; cx < cols; cx++) {
        const x = bounds.minX + (cx + 0.5) * cell;
        const z = bounds.minZ + (cz + 0.5) * cell;
        tops.length = 0;
        for (const s of world.solids) if (overlapsXZ(s, x, z, radius)) tops.push(footprintTop(s, x, z, radius));
        tops.sort((a, b) => b - a);
        const list: number[] = [];
        let last = Infinity;
        for (const top of tops) {
          if (last - top < 0.05) continue;
          last = top;
          if (!boxFree(world, x, top, z, radius, height)) continue;
          list.push(nodes.length);
          nodes.push({ id: nodes.length, x, y: top, z, links: [], comp: -1, cx, cz });
        }
        cells[cz * cols + cx] = list;
      }
    }

    const neighbour = (a: NavNode, cx: number, cz: number): number => {
      if (cx < 0 || cz < 0 || cx >= cols || cz >= rows) return -1;
      for (const id of cells[cz * cols + cx]) if (Math.abs(nodes[id].y - a.y) <= stepHeight) return id;
      return -1;
    };
    for (const n of nodes) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const id = neighbour(n, n.cx + dx, n.cz + dz);
          if (id < 0) continue;
          // Diagonals need both orthogonal cells so paths never cut a corner.
          if (dx !== 0 && dz !== 0 && (neighbour(n, n.cx + dx, n.cz) < 0 || neighbour(n, n.cx, n.cz + dz) < 0)) continue;
          n.links.push(id);
        }
      }
    }

    nav.nodes = nodes;
    nav.cells = cells;
    let comp = 0;
    for (const seed of seeds) {
      const start = nav.nearest(seed, 2.5);
      if (!start || start.comp >= 0) continue;
      const stack = [start.id];
      start.comp = comp;
      while (stack.length) {
        const cur = nodes[stack.pop()!];
        for (const l of cur.links) {
          if (nodes[l].comp < 0) {
            nodes[l].comp = comp;
            stack.push(l);
          }
        }
      }
      comp++;
    }
    const remap = new Int32Array(nodes.length).fill(-1);
    const kept: NavNode[] = [];
    for (const n of nodes) {
      if (n.comp >= 0) {
        remap[n.id] = kept.length;
        kept.push(n);
      }
    }
    for (const n of kept) n.links = n.links.filter((l) => remap[l] >= 0).map((l) => remap[l]);
    for (const n of kept) n.id = remap[n.id];
    nav.nodes = kept;
    nav.cells = cells.map((list) => list.filter((id) => remap[id] >= 0).map((id) => remap[id]));
    nav.g = new Float32Array(kept.length);
    nav.from = new Int32Array(kept.length);
    nav.seen = new Uint32Array(kept.length);
    nav.closed = new Uint32Array(kept.length);
    return nav;
  }

  nearest(p: Vec3, maxDist = 2.5): NavNode | null {
    const { cell } = this.opts;
    const cx0 = Math.floor((p.x - this.bounds.minX) / cell);
    const cz0 = Math.floor((p.z - this.bounds.minZ) / cell);
    const span = Math.ceil(maxDist / cell);
    let best: NavNode | null = null;
    let bestD = maxDist * maxDist;
    for (let dz = -span; dz <= span; dz++) {
      const cz = cz0 + dz;
      if (cz < 0 || cz >= this.rows) continue;
      for (let dx = -span; dx <= span; dx++) {
        const cx = cx0 + dx;
        if (cx < 0 || cx >= this.cols) continue;
        for (const id of this.cells[cz * this.cols + cx]) {
          const n = this.nodes[id];
          const dy = n.y - p.y;
          if (Math.abs(dy) > 1.6) continue;
          // Height is weighted so a node on the floor above or below is never preferred.
          const d = (n.x - p.x) ** 2 + (n.z - p.z) ** 2 + dy * dy * 4;
          if (d < bestD) {
            bestD = d;
            best = n;
          }
        }
      }
    }
    return best;
  }

  /** Smoothed waypoints from one position to another, or null when no route exists. */
  findPath(from: Vec3, to: Vec3): Vec3[] | null {
    const a = this.nearest(from, 3);
    const b = this.nearest(to, 3);
    if (!a || !b || a.comp !== b.comp) return null;
    const ids = this.astar(a.id, b.id);
    if (!ids) return null;
    return this.smooth(ids.map((id) => ({ x: this.nodes[id].x, y: this.nodes[id].y, z: this.nodes[id].z })));
  }

  private astar(start: number, goal: number): number[] | null {
    const nodes = this.nodes;
    const { g, from, seen, closed, heap } = this;
    const id = ++this.search;
    const target = nodes[goal];
    const h = (n: NavNode): number => Math.hypot(n.x - target.x, n.y - target.y, n.z - target.z);
    heap.clear();
    g[start] = 0;
    seen[start] = id;
    from[start] = -1;
    heap.push(start, h(nodes[start]));
    while (heap.size > 0) {
      const cur = heap.pop();
      if (cur === goal) {
        const out: number[] = [];
        for (let n = goal; n >= 0; n = from[n]) out.push(n);
        return out.reverse();
      }
      if (closed[cur] === id) continue;
      closed[cur] = id;
      const c = nodes[cur];
      for (const nb of c.links) {
        if (closed[nb] === id) continue;
        const n = nodes[nb];
        const cost = g[cur] + Math.hypot(n.x - c.x, n.y - c.y, n.z - c.z);
        if (seen[nb] !== id || cost < g[nb]) {
          seen[nb] = id;
          g[nb] = cost;
          from[nb] = cur;
          heap.push(nb, cost + h(n));
        }
      }
    }
    return null;
  }

  private smooth(pts: Vec3[]): Vec3[] {
    if (pts.length <= 2) return pts;
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = Math.min(pts.length - 1, i + 10);
      while (j > i + 1 && !this.walkable(pts[i], pts[j])) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }

  /** Can an agent walk the straight line from a to b without a wall, a drop or a tall step? */
  walkable(a: Vec3, b: Vec3): boolean {
    const steps = Math.max(1, Math.ceil(distanceXZ(a, b) / 0.25));
    let y = a.y;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const sy = this.standY(lerp(a.x, b.x, t), lerp(a.z, b.z, t), y);
      if (sy === null) return false;
      y = sy;
    }
    return Math.abs(y - b.y) < 0.3;
  }

  private standY(x: number, z: number, y: number): number | null {
    const { radius, height, stepHeight } = this.opts;
    let support = -Infinity;
    for (const s of this.world.solids) {
      if (!overlapsXZ(s, x, z, radius)) continue;
      const top = footprintTop(s, x, z, radius);
      if (top <= y + stepHeight && top > support) support = top;
    }
    if (support < y - stepHeight) return null;
    return boxFree(this.world, x, support, z, radius, height) ? support : null;
  }

  /** Random reachable nodes in a ring around a point, at roughly the given height. */
  sampleRing(center: Vec3, y: number, rMin: number, rMax: number, count: number, rng: Rng): NavNode[] {
    const out: NavNode[] = [];
    for (let i = 0; i < count; i++) {
      const a = rng() * Math.PI * 2;
      const r = lerp(rMin, rMax, rng());
      const n = this.nearest({ x: center.x + Math.cos(a) * r, y, z: center.z + Math.sin(a) * r }, 1.2);
      if (n && !out.includes(n)) out.push(n);
    }
    return out;
  }
}
