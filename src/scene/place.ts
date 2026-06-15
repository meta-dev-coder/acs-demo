/*---------------------------------------------------------------------------------------------
 * Shared placement. The synthetic corridor data carries a real EPSG:32617 frame (easting runs
 * ALONG the corridor, northing runs ACROSS it). We do NOT trust those as absolute world coords
 * (they don't line up with this particular model), but we DO use them to preserve the corridor's
 * SHAPE so overlays sit on the road instead of cutting across it.
 *
 * Strategy:
 *   1) getCenterline(): derive ONE clean, ordered centerline from the model's real road geometry
 *      by binning element origins along the dominant extent axis and taking the median lateral
 *      position per bin (robust to ramps / bridge piles / parallel lanes). This is the spine of
 *      the corridor as it actually sits in the model — monotonic, no zigzag.
 *   2) corridorPoint(): map any (easting, northing) onto that spine — easting -> fraction along
 *      (by arc length), northing -> signed lateral offset from the mainline. So mainline assets
 *      sit on the spine, express lanes / frontage / ramps fan to the correct side, and Scenario B
 *      ribbons follow the road smoothly instead of slicing across the interchange.
 *--------------------------------------------------------------------------------------------*/
import type { IModelConnection } from "@itwin/core-frontend";
import { QueryRowFormat } from "@itwin/core-common";
import { Point3d, Range3d } from "@itwin/core-geometry";

/** The synthetic data's UTM frame (stable for this demo's assets.json + segments.json).
 *  eMin/eMax span the corridor west->east; nRef is the mainline northing (lateral zero). */
const CORRIDOR = {
  eMin: 578200, // west end (I-75 / Sawgrass)
  eMax: 592000, // east end (Turnpike interchange)
  nRef: 2883000, // mainline northing -> lateral 0
  latScale: 0.32, // shrink real lateral so parallel roadways stay near the visible corridor
  latMax: 95, // clamp meters either side of the spine
};

const BINS = 90;

export interface Centerline {
  pts: Point3d[];
  cum: number[]; // cumulative arc length along pts (cum[0] = 0)
  total: number; // total length (>= 1)
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function percentileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = clamp01(q) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function percentile(values: number[], q: number): number {
  return percentileSorted([...values].sort((a, b) => a - b), q);
}

let centerlineCache: Centerline | undefined;
let roadCache: Point3d[] | undefined; // inlier road points, for snapping markers onto real geometry

/** Build (once) the clean corridor centerline from the model's real road geometry. */
export async function getCenterline(iModel: IModelConnection): Promise<Centerline> {
  if (centerlineCache) return centerlineCache;
  const raw = await queryRoadPoints(iModel);
  const pe = iModel.projectExtents;
  const inliers = raw.filter((p) => pe.containsPoint(p));
  roadCache = inliers.length >= 2 ? inliers : raw;
  centerlineCache = buildCenterline(raw, pe);
  return centerlineCache;
}

/** Snap a point to the NEAREST real road element (in plan), lifted above it. Guarantees markers
 *  sit ON the highway geometry instead of on the median/embankment the centerline may run along.
 *  `road` defaults to the cached inliers; pass an array for testing. */
export function snapToRoad(pt: Point3d, liftZ = 8, road: Point3d[] | undefined = roadCache): Point3d {
  if (!road || road.length === 0) return Point3d.create(pt.x, pt.y, pt.z + liftZ);
  let best = road[0];
  let bestD = Infinity;
  for (const p of road) {
    const dx = p.x - pt.x;
    const dy = p.y - pt.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return Point3d.create(best.x, best.y, best.z + liftZ);
}

async function queryRoadPoints(iModel: IModelConnection): Promise<Point3d[]> {
  const all: { p: Point3d; cls: string }[] = [];
  try {
    const reader = iModel.createQueryReader(
      "SELECT Origin, ec_classname(ECClassId) AS cls FROM bis.GeometricElement3d WHERE Origin IS NOT NULL LIMIT 30000",
      undefined,
      { rowFormat: QueryRowFormat.UseJsPropertyNames }
    );
    for await (const row of reader) {
      const r = row.toRow() as {
        origin?: { x?: number; y?: number; z?: number; X?: number; Y?: number; Z?: number };
        cls?: string;
      };
      const o = r.origin;
      if (!o) continue;
      const x = o.x ?? o.X;
      const y = o.y ?? o.Y;
      const z = o.z ?? o.Z ?? 0;
      if (typeof x === "number" && typeof y === "number")
        all.push({ p: Point3d.create(x, y, z), cls: r.cls ?? "" });
    }
  } catch (e) {
    console.warn("[place] road-point query failed:", e);
  }
  // Prefer actual road-surface elements (lanes / pavement / roadway / travelway) so markers and
  // ribbons snap onto the CARRIAGEWAY, not medians / structures / embankments. Fall back to every
  // origin if the model uses other class names (logged so we can refine the filter).
  const roadRe = /lane|road|pavement|carriage|travel|asphalt|surfac|driv/i;
  const surface = all.filter((r) => roadRe.test(r.cls)).map((r) => r.p);
  return surface.length >= 50 ? surface : all.map((r) => r.p);
}

export function buildCenterline(raw: Point3d[], extents: Range3d): Centerline {
  // Fallback when the model has no usable geometry: a straight line along the dominant axis.
  if (raw.length < 2) {
    const alongX = extents.high.x - extents.low.x >= extents.high.y - extents.low.y;
    const z = (extents.low.z + extents.high.z) / 2;
    const midY = (extents.low.y + extents.high.y) / 2;
    const midX = (extents.low.x + extents.high.x) / 2;
    const a = alongX ? Point3d.create(extents.low.x, midY, z) : Point3d.create(midX, extents.low.y, z);
    const b = alongX ? Point3d.create(extents.high.x, midY, z) : Point3d.create(midX, extents.high.y, z);
    return finalize([a, b]);
  }

  // Filter to the model's OWN bounds FIRST. The connector parks a large fraction (~5%+) of
  // element origins at the spatial origin (0,0,0) and other far points; percentile clipping can't
  // survive that, but projectExtents reliably bounds the real geometry and excludes the strays.
  let inliers = raw.filter((p) => extents.containsPoint(p));
  if (inliers.length < 2) inliers = raw; // projectExtents unusable -> fall back to everything

  const xs = inliers.map((p) => p.x).sort((a, b) => a - b);
  const ys = inliers.map((p) => p.y).sort((a, b) => a - b);
  const xSpan = percentileSorted(xs, 0.99) - percentileSorted(xs, 0.01);
  const ySpan = percentileSorted(ys, 0.99) - percentileSorted(ys, 0.01);
  const alongX = xSpan >= ySpan;
  const alongOf = (p: Point3d) => (alongX ? p.x : p.y);
  const acrossOf = (p: Point3d) => (alongX ? p.y : p.x);

  const lo = alongX ? percentileSorted(xs, 0.01) : percentileSorted(ys, 0.01);
  const hi = alongX ? percentileSorted(xs, 0.99) : percentileSorted(ys, 0.99);
  const crossMid = alongX ? percentileSorted(ys, 0.5) : percentileSorted(xs, 0.5);
  const span = hi - lo || 1;

  const clean = inliers.filter((p) => alongOf(p) >= lo && alongOf(p) <= hi);
  if (clean.length < 2)
    return finalize([
      alongX ? Point3d.create(lo, crossMid, extents.low.z) : Point3d.create(crossMid, lo, extents.low.z),
      alongX ? Point3d.create(hi, crossMid, extents.low.z) : Point3d.create(crossMid, hi, extents.low.z),
    ]);

  // Bucket points by along-coordinate.
  const buckets: Point3d[][] = Array.from({ length: BINS }, () => []);
  for (const p of clean) {
    let bi = Math.floor(((alongOf(p) - lo) / span) * BINS);
    if (bi < 0) bi = 0;
    if (bi >= BINS) bi = BINS - 1;
    buckets[bi].push(p);
  }

  // One centerline point per non-empty bin: (bin-center along, MEDIAN across, low-percentile z).
  // Median across is robust to ramps/outliers; low-percentile z biases toward the road deck.
  let cl: Point3d[] = [];
  for (let bi = 0; bi < BINS; bi++) {
    const b = buckets[bi];
    if (b.length === 0) continue;
    const alongCenter = lo + ((bi + 0.5) / BINS) * span;
    const across = percentile(b.map(acrossOf), 0.5);
    const z = percentile(b.map((p) => p.z), 0.3);
    cl.push(alongX ? Point3d.create(alongCenter, across, z) : Point3d.create(across, alongCenter, z));
  }

  cl = smooth(cl, alongX);
  cl = smooth(cl, alongX); // second pass — cleaner spine for ribbons + marker base

  // Orient so the DENSE end (interchange — bridge piles, ramps, beams) is u=1, so the connector
  // hotspot and the red asset cluster land at the real interchange regardless of model orientation.
  const frac = (p: Point3d) => (alongOf(p) - lo) / span;
  const firstQ = clean.filter((p) => frac(p) < 0.25).length;
  const lastQ = clean.filter((p) => frac(p) > 0.75).length;
  if (firstQ > lastQ) cl.reverse();

  return finalize(cl);
}

/** Moving-average smoothing (window 3) on the across + z components to remove residual wobble. */
function smooth(cl: Point3d[], alongX: boolean): Point3d[] {
  if (cl.length < 3) return cl;
  const out: Point3d[] = [];
  for (let i = 0; i < cl.length; i++) {
    const a = cl[Math.max(0, i - 1)];
    const b = cl[i];
    const c = cl[Math.min(cl.length - 1, i + 1)];
    const acr = ((alongX ? a.y : a.x) + (alongX ? b.y : b.x) + (alongX ? c.y : c.x)) / 3;
    const z = (a.z + b.z + c.z) / 3;
    out.push(alongX ? Point3d.create(b.x, acr, z) : Point3d.create(acr, b.y, z));
  }
  return out;
}

function finalize(pts: Point3d[]): Centerline {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i - 1].distanceXY(pts[i]));
  const total = cum[cum.length - 1] || 1;
  console.log(`[place] corridor centerline: ${pts.length} pts, ${total.toFixed(0)} m long.`);
  return { pts, cum, total };
}

/** Position at arc-length fraction u (0..1) along the centerline, offset `lateral` meters
 *  perpendicular (in plan), lifted `liftZ` meters above the road. */
function pointAlong(cl: Centerline, u: number, lateral: number, liftZ: number): Point3d {
  const { pts, cum, total } = cl;
  if (pts.length === 0) return Point3d.create(0, 0, 0);
  if (pts.length === 1) return Point3d.create(pts[0].x, pts[0].y, pts[0].z + liftZ);

  const s = clamp01(u) * total;
  let i = 0;
  while (i < pts.length - 2 && cum[i + 1] <= s) i++;
  const segLen = cum[i + 1] - cum[i] || 1;
  const f = clamp01((s - cum[i]) / segLen);
  const a = pts[i];
  const b = pts[i + 1];
  const bx = a.x + (b.x - a.x) * f;
  const by = a.y + (b.y - a.y) * f;
  const bz = a.z + (b.z - a.z) * f;

  // Perpendicular to the local tangent, in the XY plane.
  let tx = b.x - a.x;
  let ty = b.y - a.y;
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl;
  ty /= tl;
  const px = -ty;
  const py = tx;
  return Point3d.create(bx + px * lateral, by + py * lateral, bz + liftZ);
}

/** Map a corridor UTM coordinate (easting, northing) onto the model centerline. `lateralFactor`
 *  scales the northing->lateral offset; pass 0 to stay exactly on the centerline (used for ribbons,
 *  which then snap to the road — the raw lateral offset would push them off into water/grass). */
export function corridorPoint(
  cl: Centerline,
  e: number,
  n: number,
  liftZ = 6,
  lateralFactor = 1
): Point3d {
  const u = clamp01((e - CORRIDOR.eMin) / (CORRIDOR.eMax - CORRIDOR.eMin));
  let lateral = (n - CORRIDOR.nRef) * CORRIDOR.latScale * lateralFactor;
  lateral = Math.max(-CORRIDOR.latMax, Math.min(CORRIDOR.latMax, lateral));
  return pointAlong(cl, u, lateral, liftZ);
}

/** Moving-average smoothing of a polyline (endpoints fixed) — turns road-snapped, edge-bouncing
 *  samples into a clean line that runs through the pavement. */
export function smoothPolyline(pts: Point3d[], passes = 1): Point3d[] {
  let cur = pts;
  for (let k = 0; k < passes; k++) {
    if (cur.length < 3) break;
    const out: Point3d[] = [cur[0]];
    for (let i = 1; i < cur.length - 1; i++) {
      const a = cur[i - 1];
      const b = cur[i];
      const c = cur[i + 1];
      out.push(Point3d.create((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3));
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}

/** Order points monotonically along the chord (first->last) and drop near-duplicates, so a set of
 *  road-snapped samples reads as a clean ribbon along the road instead of a back-and-forth zigzag. */
export function orderAlongChord(pts: Point3d[], dedupeM = 2): Point3d[] {
  if (pts.length < 2) return pts;
  const a = pts[0];
  const b = pts[pts.length - 1];
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return pts;
  dx /= len;
  dy /= len;
  const proj = (p: Point3d) => (p.x - a.x) * dx + (p.y - a.y) * dy;
  const sorted = [...pts].sort((p, q) => proj(p) - proj(q));
  const out: Point3d[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (!last || last.distanceXY(p) > dedupeM) out.push(p);
  }
  return out.length >= 2 ? out : pts;
}
