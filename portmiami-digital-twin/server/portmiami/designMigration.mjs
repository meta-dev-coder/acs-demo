/**
 * One-time reclassification of stored design alternatives into infrastructure domains.
 *
 * THE PROBLEM IT FIXES. The three alternatives this twin shipped with are parking sketches, and
 * the Road Design Studio was built on the same three records. Users then drew roads into them, so
 * a single stored record — `design-a` at revision 24 — holds a garage expansion AND a widening, a
 * realignment, a closure and a new road. Opening the road studio drew the garage too.
 *
 * WHAT IT DOES. Each record is split by element domain (see `src/designs/designDomain.js`):
 *   - parking and mixed elements STAY in the original record, which keeps its id and name;
 *   - road elements MOVE to a road-domain record, `design-a` -> `road-design-a`;
 *   - both records keep an explicit `domain`, so this never has to be decided again.
 *
 * WHAT IT WILL NOT DO. It deletes nothing. Every element present before is present after, in one
 * record or the other, and the counts are asserted before the result is returned — a migration
 * that cannot account for an element refuses rather than writes. It also writes the untouched
 * original to a sibling backup file first, so the whole thing is one `mv` away from being undone.
 *
 * IT RUNS ONCE. A record that already declares a `domain` is passed through, so a second start-up
 * is a no-op and a user who classifies a design by hand is not overruled.
 */
import { copyFile } from 'node:fs/promises';
import {
  DESIGN_DOMAIN, classifyDesign, splitByDomain,
} from '../../src/designs/designDomain.js';

/** Which road-domain record each legacy parking alternative's roads move into. */
export const ROAD_DESIGN_FOR = Object.freeze({
  'design-a': 'road-design-a',
  'design-b': 'road-design-b',
  'design-c': 'road-design-c',
});

export const ROAD_DESIGN_NAME = Object.freeze({
  'road-design-a': 'Design A',
  'road-design-b': 'Design B',
  'road-design-c': 'Design C',
});

export const needsMigration = designs =>
  (designs ?? []).some(design => !DESIGN_DOMAIN[design?.domain]);

/**
 * Split stored records by domain. Pure: it reads `designs` and returns new ones.
 *
 * Returns `{ ok, designs, moved, report }`. `ok` is false — and `designs` is handed back
 * unchanged — if any element would be lost, because a partly applied migration of someone's saved
 * work is worse than none at all.
 */
export function migrateDesigns(designs = []) {
  const before = designs.reduce((total, design) => total + (design.elements?.length ?? 0), 0);
  const out = new Map();
  const moved = [];

  for (const stored of designs) {
    if (DESIGN_DOMAIN[stored?.domain]) { out.set(stored.id, stored); continue; }
    const roadId = ROAD_DESIGN_FOR[stored.id];
    const { road, parking, mixed } = splitByDomain(stored);

    // Nothing to move: classify in place and leave it alone.
    if (!roadId || road.length === 0) { out.set(stored.id, classifyDesign(stored)); continue; }

    // The parking record keeps its id, name and revision; it just loses the roads that were
    // never part of it. A record left with no elements at all still stays, so its revision
    // history and name survive for the future parking workspace.
    out.set(stored.id, classifyDesign({ ...stored, elements: [...parking, ...mixed] }));

    const existing = out.get(roadId);
    out.set(roadId, {
      ...(existing ?? {
        id: roadId,
        name: ROAD_DESIGN_NAME[roadId] ?? roadId,
        description: 'Proposed road changes.',
        source: 'USER_DRAWN',
        verificationStatus: 'CONCEPTUAL',
        revision: stored.revision ?? '01',
        crs: 'EPSG:4326',
        units: 'metre',
        updatedAt: stored.updatedAt ?? null,
        // Where these elements came from, so the split is legible in the file itself.
        migratedFrom: stored.id,
        elements: [],
      }),
      domain: DESIGN_DOMAIN.ROAD_INFRASTRUCTURE,
      elements: [
        ...(existing?.elements ?? []),
        ...road.map(element => ({ ...element, domain: DESIGN_DOMAIN.ROAD_INFRASTRUCTURE })),
      ],
    });
    moved.push({ from: stored.id, to: roadId, roads: road.length, kept: parking.length + mixed.length });
  }

  const result = [...out.values()];
  const after = result.reduce((total, design) => total + (design.elements?.length ?? 0), 0);
  if (after !== before) {
    return {
      ok: false,
      designs,
      moved: [],
      report: `Migration would change the element count from ${before} to ${after}; refused.`,
    };
  }
  return {
    ok: true,
    designs: result,
    moved,
    report: moved.length === 0
      ? `Classified ${result.length} design(s); no roads needed re-homing.`
      : moved.map(m => `${m.roads} road element(s) ${m.from} -> ${m.to}, ${m.kept} kept in ${m.from}`)
        .join('; '),
  };
}

/** Copy the store beside itself before anything is rewritten. Best effort, and it says so. */
export async function backupStore(storePath) {
  const backup = `${storePath.replace(/\.json$/, '')}.pre-domain-migration.json`;
  try {
    await copyFile(storePath, backup, /* COPYFILE_EXCL */ 1);
    return { ok: true, backup };
  } catch (error) {
    // EEXIST means the backup is already there from an earlier run: the original is still safe.
    if (error.code === 'EEXIST') return { ok: true, backup, existing: true };
    return { ok: false, reason: error.message };
  }
}
