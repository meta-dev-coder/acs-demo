/**
 * Where design alternatives live between sessions.
 *
 * Same shape as `geometryStore.mjs` and for the same reasons: one JSON file, validated on the way
 * in, written through a temporary file and renamed so a crash mid-write cannot leave a truncated
 * store, and writes serialised within the process.
 *
 * MULTI-PROCESS LIMIT, STATED. The serialisation is a promise chain inside ONE node process. Two
 * processes writing the same file — a `npm run dev` and a standalone server, or two containers on
 * a shared volume — can still interleave and lose a write, because the rename is atomic but the
 * read-modify-write around it is not. This is adequate for a single editing host and is not a
 * shared-database substitute. Anything beyond that needs real locking or a database, and the
 * store should not pretend otherwise.
 *
 * OPTIMISTIC CONCURRENCY, WITHIN ONE PROCESS. A save may carry the revision it was made against.
 * If the stored revision has moved on, the write is REFUSED and the caller is handed the current
 * record, so two people editing the same alternative get a conflict they can see rather than one
 * of them silently losing their work. It closes the last-writer-wins window inside this process;
 * it does not close the cross-process window above, because nothing here can.
 *
 * BASELINE IS NEVER WRITTEN. The county road and building files are read-only inputs. A design is
 * a set of changes that reference them, so nothing in here can alter what the port actually is.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupStore, migrateDesigns, needsMigration } from './designMigration.mjs';

export const SCHEMA_VERSION = 1;

const here = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_STORE_PATH = resolve(here, '../data/design-alternatives.json');

export const storePathFrom = (env = process.env) =>
  (env.PORTMIAMI_DESIGN_FILE ? resolve(env.PORTMIAMI_DESIGN_FILE) : DEFAULT_STORE_PATH);

export const CHANGE_TYPES = new Set(['NEW', 'MODIFIED', 'REMOVED', 'UNCHANGED']);
export const ELEMENT_TYPES = new Set([
  'ROAD', 'BUILDING', 'PARKING_GARAGE', 'SURFACE_PARKING', 'TERMINAL', 'ACCESS_INFRASTRUCTURE',
]);
export const VERIFICATION_STATUSES = new Set(['CONCEPTUAL', 'SUBMITTED', 'APPROVED']);
/** The road operations a design may be restricted to. */
export const OPERATIONS = new Set(['WIDEN', 'CREATE', 'REALIGN', 'CLOSE']);
export const DOMAINS = new Set([
  'ROAD_INFRASTRUCTURE', 'PARKING_INFRASTRUCTURE', 'MIXED_INFRASTRUCTURE',
]);

/** The study area. A coordinate outside it is an unreferenced CAD coordinate, not a location. */
export const STUDY_AREA = Object.freeze({
  west: -80.25, east: -80.10, south: 25.70, north: 25.85,
});

const finite = value => typeof value === 'number' && Number.isFinite(value);
const inStudyArea = ([lon, lat] = []) =>
  finite(lon) && finite(lat)
  && lon >= STUDY_AREA.west && lon <= STUDY_AREA.east
  && lat >= STUDY_AREA.south && lat <= STUDY_AREA.north;

const pointsOf = geometry => {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return geometry.coordinates ?? [];
  if (geometry.type === 'Point') return [geometry.coordinates ?? []];
  if (geometry.type === 'Polygon') return (geometry.coordinates ?? []).flat();
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates ?? []).flat(2);
  return [];
};

/**
 * Validate a design package server-side.
 *
 * The browser validates too, but the browser is not the authority: anything that can reach this
 * endpoint can send whatever it likes, so the checks are repeated here rather than trusted.
 */
export function validateDesign(design) {
  const errors = [];
  if (!design || typeof design !== 'object') return { ok: false, errors: ['Not an object.'] };
  if (!design.id || typeof design.id !== 'string') errors.push('A design needs a string id.');
  if (design.id === 'baseline') errors.push('The baseline is read-only and cannot be stored.');
  if (!design.name || typeof design.name !== 'string') errors.push('A design needs a name.');
  if (design.crs && design.crs !== 'EPSG:4326') {
    errors.push(`Coordinates are declared as ${design.crs}; this store accepts EPSG:4326 only.`);
  }
  if (design.verificationStatus && !VERIFICATION_STATUSES.has(design.verificationStatus)) {
    errors.push(`Unknown verification status "${design.verificationStatus}".`);
  }
  // A domain may be absent on an older record — the migration fills those in — but a domain that
  // is present and unrecognised would silently hide the design from every workspace.
  if (design.domain && !DOMAINS.has(design.domain)) {
    errors.push(`Unknown infrastructure domain "${design.domain}".`);
  }
  if (!Array.isArray(design.elements)) {
    errors.push('A design needs an elements array.');
    return { ok: errors.length === 0, errors };
  }
  if (design.elements.length > 500) errors.push('More than 500 elements in one design.');

  /*
   * ONE OPERATION PER ALTERNATIVE, ENFORCED HERE.
   *
   * A design that declares `allowedOperation` (Design A widens, B builds new road, C realigns)
   * may hold only road elements of that operation. Checked on the server because the browser's
   * check is a courtesy: anything that can reach this endpoint could otherwise save a new road
   * into the widening alternative. Records that declare nothing are unaffected.
   */
  if (design.allowedOperation !== undefined && design.allowedOperation !== null) {
    if (!OPERATIONS.has(design.allowedOperation)) {
      errors.push(`Unknown allowed operation "${design.allowedOperation}".`);
    } else {
      for (const element of design.elements) {
        if (element?.type !== 'ROAD' || element?.operation !== design.allowedOperation) {
          errors.push(`Element "${element?.id}" is ${element?.operation ?? element?.type ?? 'not a road operation'}; `
            + `"${design.name}" accepts ${design.allowedOperation} only.`);
        }
      }
    }
  }

  const seen = new Set();
  for (const element of design.elements) {
    if (!element?.id || typeof element.id !== 'string') { errors.push('An element has no id.'); continue; }
    if (seen.has(element.id)) errors.push(`Duplicate element id "${element.id}".`);
    seen.add(element.id);
    if (!ELEMENT_TYPES.has(element.type)) errors.push(`Element "${element.id}": unknown type.`);
    if (!CHANGE_TYPES.has(element.changeType)) errors.push(`Element "${element.id}": unknown change type.`);
    if ((element.changeType === 'MODIFIED' || element.changeType === 'REMOVED')
      && !element.baselineRef) {
      errors.push(`Element "${element.id}" is ${element.changeType} but names no baseline feature.`);
    }
    const points = pointsOf(element.geometry);
    if (points.length > 10_000) { errors.push(`Element "${element.id}": too many coordinates.`); continue; }
    for (const point of points) {
      if (!Array.isArray(point) || !finite(point[0]) || !finite(point[1])) {
        errors.push(`Element "${element.id}": a coordinate is not a pair of numbers.`);
        break;
      }
      if (!inStudyArea(point) && inStudyArea([point[1], point[0]])) {
        errors.push(`Element "${element.id}": looks like latitude, longitude — expected longitude first.`);
        break;
      }
      if (!inStudyArea(point)) {
        errors.push(`Element "${element.id}": a coordinate is outside the PortMiami study area.`);
        break;
      }
    }
    if (element.type === 'ROAD' && element.changeType !== 'REMOVED') {
      const width = element.properties?.widthM;
      if (width !== undefined && (!finite(width) || width <= 0 || width > 60)) {
        errors.push(`Element "${element.id}": road width must be between 0 and 60 m.`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

const empty = () => ({ version: SCHEMA_VERSION, designs: [] });

export function createDesignStore({ path = storePathFrom(), now = () => new Date().toISOString() } = {}) {
  /** Serialises writes within this process; see the file header on the multi-process limit. */
  let queue = Promise.resolve();

  async function read() {
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== SCHEMA_VERSION) return empty();
      return { version: SCHEMA_VERSION, designs: Array.isArray(parsed.designs) ? parsed.designs : [] };
    } catch (error) {
      if (error.code === 'ENOENT') return empty();
      throw error;
    }
  }

  async function write(state) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  }

  /**
   * Every record a save or delete is about to replace, appended to a sibling file first.
   *
   * Append-only JSON lines, one superseded revision per line, so a cleanup or an accidental
   * overwrite is always recoverable by copying a line back. The live file stays small; the history
   * is never read on the request path.
   */
  const historyPath = `${path.replace(/\.json$/, '')}.history.jsonl`;
  async function keep(previous, reason) {
    if (!previous) return;
    await mkdir(dirname(path), { recursive: true });
    await appendFile(historyPath,
      `${JSON.stringify({ supersededAt: now(), reason, design: previous })}\n`, 'utf8');
  }

  const serialise = task => {
    const next = queue.then(task, task);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };

  return {
    path,
    historyPath,

    async writable() {
      try {
        await mkdir(dirname(path), { recursive: true });
        const probe = `${path}.${process.pid}.probe`;
        await writeFile(probe, '{}', 'utf8');
        const { unlink } = await import('node:fs/promises');
        await unlink(probe);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error.message };
      }
    },

    /**
     * Classify stored records into infrastructure domains, once.
     *
     * Serialised with the writes, so it cannot interleave with a save, and a no-op once every
     * record declares a domain. The original file is copied aside before anything is rewritten,
     * and a migration that cannot account for every element writes nothing.
     */
    async migrateOnce() {
      return serialise(async () => {
        const state = await read();
        if (!needsMigration(state.designs)) return { ok: true, migrated: false };
        const result = migrateDesigns(state.designs);
        if (!result.ok) return { ok: false, migrated: false, reason: result.report };
        const backup = await backupStore(path);
        if (!backup.ok) {
          return { ok: false, migrated: false, reason: `Could not back up the store: ${backup.reason}` };
        }
        await write({ version: SCHEMA_VERSION, designs: result.designs });
        return { ok: true, migrated: true, report: result.report, backup: backup.backup };
      });
    },

    async list() {
      return (await read()).designs;
    },

    async get(designId) {
      return (await read()).designs.find(design => design.id === designId) ?? null;
    },

    /**
     * Store one design, replacing any earlier revision of the same id.
     *
     * `createdAt` is preserved from the record being replaced, so saving again does not make a
     * design look newly made, and `revision` increments so two saves are tellable apart.
     */
    /**
     * @param {object} design
     * @param {object} [options]
     * @param {string|null} [options.ifRevision] the revision this edit was made against. Omit to
     *   force the write; pass it to be refused when someone else has saved in the meantime.
     */
    async save(design, { ifRevision = undefined } = {}) {
      return serialise(async () => {
        const state = await read();
        const timestamp = now();
        const previous = state.designs.find(row => row.id === design.id);
        if (ifRevision !== undefined) {
          const current = previous?.revision ?? null;
          if ((current ?? null) !== (ifRevision ?? null)) {
            return {
              ok: false,
              conflict: true,
              reason: previous
                ? `This alternative has moved on to revision ${current} since you began editing `
                  + `(you started from ${ifRevision ?? 'nothing saved'}). Your draft has not been `
                  + 'overwritten and neither has theirs.'
                : 'This alternative is no longer stored, so there is no revision to build on.',
              current: previous ?? null,
            };
          }
        }
        const stored = {
          ...design,
          revision: String(Number(previous?.revision ?? 0) + 1).padStart(2, '0'),
          createdAt: previous?.createdAt ?? timestamp,
          updatedAt: timestamp,
        };
        state.designs = [...state.designs.filter(row => row.id !== design.id), stored];
        await keep(previous, 'save');
        await write(state);
        return { ok: true, design: stored };
      });
    },

    async remove(designId) {
      return serialise(async () => {
        const state = await read();
        const before = state.designs.length;
        const removed = state.designs.find(design => design.id === designId);
        state.designs = state.designs.filter(design => design.id !== designId);
        if (state.designs.length !== before) {
          await keep(removed, 'delete');
          await write(state);
        }
        return { removed: before - state.designs.length };
      });
    },
  };
}
