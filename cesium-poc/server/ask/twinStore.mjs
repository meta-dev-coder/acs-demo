/**
 * The twin store: a local SQLite read model of the records Ask the Twin answers from.
 *
 * DataConnect stays the system of record. This file is a copy built by a sync step, so a question
 * reads milliseconds-old local rows instead of paging a remote API mid-answer. Nothing here writes to
 * DataConnect, and nothing in the ask path writes to the store: the builder replaces the whole file
 * atomically and readers open it read-only.
 *
 * One generic table keeps every class (the record's own fields as JSON, plus the few columns the
 * corridor queries by), and `columns` lists each class's real field names so a filter on a field that
 * does not exist is refused instead of silently matching nothing. `store_meta` says when each class
 * was loaded, so a tool can tell "no rows" from "not loaded yet" — a confident answer from an empty
 * table is exactly the failure this exists to prevent.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Classes the repository snapshot (public/dataconnect-data) carries, and how to index each. */
export const SNAPSHOT_CLASSES = Object.freeze([
  { file: 'asset_registry.json', className: 'Florida I595 Assets', key: ['Asset ID'], at: ['Instal Date'],
    lon: ['X Coordinates'], lat: ['Y Coordinates'], segment: ['Segment'] },
  { file: 'incidents_v3.json', className: 'Florida I595 Incidents', key: ['incident_id'], at: ['incident_date'],
    lon: ['x_coordinate (from asset)'], lat: ['y_coordinate (from asset)'], segment: ['Segment'] },
  { file: 'tickets.json', className: 'Florida I595 Tickets', key: ['Ticket ID'], at: ['Ticket Opened Date'],
    lon: ['X Coordinate'], lat: ['Y Coordinate'], segment: ['Segment'] },
  { file: 'tasks.json', className: 'Florida I595 Tasks', key: ['Task ID'], at: ['Task Date'],
    lon: ['X Coordinate'], lat: ['Y Coordinate'], segment: ['Segment'] },
  { file: 'work_orders.json', className: 'Florida I595 Work Orders', key: ['Work Order ID'], at: ['Work Order Open Date'],
    lon: [], lat: [], segment: ['Segment'] },
  { file: 'its_inspections_v3.json', className: 'Florida I595 ITS Inspections', key: ['inspection_id', 'record_id'],
    at: ['inspection_date', 'date'], lon: ['x_coordinates'], lat: ['y_coordinates'], segment: ['segment'] },
  { file: 'roadway_inspections_v3.json', className: 'Florida I595 Roadway Inspections', key: ['inspection_id'],
    at: ['inspection_date'], lon: ['x_coordinate'], lat: ['y_coordinate'], segment: ['segment'] },
  { file: 'safety_inspections_v3.json', className: 'Florida I595 Safety Inspections', key: ['record_id'], at: ['date'],
    lon: ['x_coordinate (from roadway)'], lat: ['y_coordinate (from roadway)'], segment: ['Segment'] },
]);

export const OPERATORS = Object.freeze(['equals', 'contains']);
export const MAX_LIMIT = 50;
const MAX_GROUPS = 25;
const DAY_MS = 86_400_000;

const SCHEMA = `
  CREATE TABLE records (class TEXT NOT NULL, key TEXT NOT NULL, segment TEXT, lon REAL, lat REAL, at TEXT,
    json TEXT NOT NULL, PRIMARY KEY (class, key));
  CREATE INDEX records_class_at ON records (class, at);
  CREATE INDEX records_class_segment ON records (class, segment);
  CREATE TABLE columns (class TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (class, name));
  CREATE TABLE store_meta (class TEXT PRIMARY KEY, as_of TEXT NOT NULL, source TEXT NOT NULL,
    row_count INTEGER NOT NULL, status TEXT NOT NULL);`;

const firstOf = (row, names) => {
  for (const name of names) {
    const value = row?.[name];
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return null;
};
const finite = value => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null);

/**
 * Write a fresh store to `outPath`, replacing any previous one in a single rename so a reader never
 * sees a half-built file.
 *
 * @param {{outPath: string, classes: {spec: object, rows: object[], source: string}[], asOf?: string}} input
 * @returns {{outPath: string, classes: {className: string, rowCount: number, skipped: number}[]}}
 */
export function writeTwinStore({ outPath, classes, asOf = new Date().toISOString() }) {
  mkdirSync(dirname(outPath), { recursive: true });
  const temp = `${outPath}.building-${process.pid}`;
  rmSync(temp, { force: true });
  const db = new DatabaseSync(temp);
  const report = [];
  try {
    db.exec(SCHEMA);
    const insert = db.prepare('INSERT INTO records (class, key, segment, lon, lat, at, json) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const column = db.prepare('INSERT OR IGNORE INTO columns (class, name) VALUES (?, ?)');
    const meta = db.prepare('INSERT INTO store_meta (class, as_of, source, row_count, status) VALUES (?, ?, ?, ?, ?)');
    const stored = db.prepare('SELECT count(*) AS n FROM records WHERE class = ?');
    db.exec('BEGIN');
    for (const { spec, rows, source } of classes) {
      let skipped = 0, duplicates = 0;
      const names = new Set();
      const seen = new Map();
      for (const row of rows) {
        const id = firstOf(row, spec.key);
        // A record with no id cannot be cited as evidence, so it is counted and left out.
        if (id === null) { skipped++; continue; }
        // The snapshot repeats some ids on distinct rows. Dropping a repeat would undercount crashes, so
        // every row is kept and a repeat is cited as `<id>#2`, `<id>#3`.
        const n = (seen.get(String(id)) ?? 0) + 1;
        seen.set(String(id), n);
        if (n > 1) duplicates++;
        const key = n > 1 ? `${id}#${n}` : String(id);
        for (const name of Object.keys(row)) names.add(name);
        const segment = firstOf(row, spec.segment);
        insert.run(spec.className, key, segment === null ? null : String(segment), finite(firstOf(row, spec.lon)),
          finite(firstOf(row, spec.lat)), firstOf(row, spec.at) === null ? null : String(firstOf(row, spec.at)), JSON.stringify(row));
      }
      for (const name of names) column.run(spec.className, name);
      const rowCount = stored.get(spec.className).n;
      meta.run(spec.className, asOf, source, rowCount, 'ready');
      report.push({ className: spec.className, rowCount, skipped, duplicates });
    }
    db.exec('COMMIT');
  } catch (error) {
    db.close();
    rmSync(temp, { force: true });
    throw error;
  }
  db.close();
  renameSync(temp, outPath);
  return { outPath, classes: report };
}

/** Build the store from the JSON snapshot committed under public/dataconnect-data. */
export function buildStoreFromSnapshot({ snapshotDir, outPath, asOf }) {
  const classes = SNAPSHOT_CLASSES.map(spec => {
    const rows = JSON.parse(readFileSync(join(snapshotDir, spec.file), 'utf8'));
    if (!Array.isArray(rows)) throw new Error(`${spec.file} is not a JSON array`);
    return { spec, rows, source: `snapshot:${spec.file}` };
  });
  return writeTwinStore({ outPath, classes, asOf });
}

const gap = (type, className, detail) => ({ gap: { type, className, detail } });

/**
 * Open a store for reading. A missing file is not an error: every class then reports `not_ready`,
 * which the tools turn into a stated data gap.
 *
 * @param {string} path
 * @param {{now?: () => number, staleAfterMs?: number}} [options]  `staleAfterMs` 0 = never stale (snapshots)
 */
export function openTwinStore(path, { now = Date.now, staleAfterMs = 0 } = {}) {
  const db = existsSync(path) ? new DatabaseSync(path, { readOnly: true }) : null;
  const metaRows = db ? db.prepare('SELECT class, as_of, source, row_count, status FROM store_meta').all() : [];
  const meta = new Map(metaRows.map(row => [row.class.toLowerCase(), row]));
  const columnsOf = new Map();
  if (db) {
    for (const { class: name, column } of db.prepare('SELECT class, name AS column FROM columns ORDER BY class, name').all()) {
      const key = name.toLowerCase();
      if (!columnsOf.has(key)) columnsOf.set(key, []);
      columnsOf.get(key).push(column);
    }
  }

  /** The class's metadata, or a typed gap saying why it cannot be read. */
  function check(className) {
    const entry = meta.get(String(className ?? '').trim().toLowerCase());
    if (!entry) {
      const known = [...meta.values()].map(row => row.class);
      return gap('not_ready', className, known.length ? `Unknown class. Loaded classes: ${known.join(', ')}.` : 'The twin store has not been built yet.');
    }
    if (entry.status !== 'ready') return gap('not_ready', entry.class, `Status is ${entry.status}.`);
    if (staleAfterMs > 0 && now() - Date.parse(entry.as_of) > staleAfterMs) {
      return gap('stale', entry.class, `Last loaded ${entry.as_of}, older than ${Math.round(staleAfterMs / DAY_MS * 24)} h.`);
    }
    return { entry, columns: columnsOf.get(entry.class.toLowerCase()) ?? [] };
  }

  /** WHERE clause and parameters for validated filters; a field the class does not have is refused. */
  function where(entry, columns, filters) {
    if (!Array.isArray(filters)) throw new TypeError('filters must be an array');
    const clauses = ['class = ?'];
    const params = [entry.class];
    for (const filter of filters) {
      if (!OPERATORS.includes(filter?.operator)) throw new TypeError(`Operator must be one of: ${OPERATORS.join(', ')}.`);
      const field = String(filter.field ?? '');
      let expression;
      if (field === 'key') expression = 'key';
      else if (columns.includes(field)) { expression = 'CAST(json_extract(json, ?) AS TEXT)'; params.push(`$."${field}"`); }
      else throw new TypeError(`'${field}' is not a field of ${entry.class}. Fields: ${columns.slice(0, 40).join(', ')}${columns.length > 40 ? ', …' : ''}.`);
      if (filter.operator === 'equals') {
        clauses.push(`${expression} = ?`);
        params.push(String(filter.value ?? ''));
      } else {
        clauses.push(`lower(${expression}) LIKE ? ESCAPE '\\'`);
        params.push(`%${String(filter.value ?? '').toLowerCase().replace(/[\\%_]/g, c => `\\${c}`)}%`);
      }
    }
    return { sql: clauses.join(' AND '), params };
  }

  const limitOf = (value, max) => Math.min(max, Math.max(1, Number.parseInt(value ?? 10, 10) || 10));

  return {
    /** Every loaded class with its load time, source, row count and field names. */
    classes: () => [...meta.values()].map(row => ({
      className: row.class, asOf: row.as_of, source: row.source, rowCount: row.row_count, status: row.status,
      fields: columnsOf.get(row.class.toLowerCase()) ?? [],
    })),

    check,

    /**
     * Matching records of one class, newest first.
     * @returns {{className, asOf, totalCount, records: object[]} | {gap}}
     */
    query(className, { filters = [], fields = null, limit } = {}) {
      const checked = check(className);
      if (checked.gap) return checked;
      const { entry, columns } = checked;
      const { sql, params } = where(entry, columns, filters);
      const wanted = Array.isArray(fields) && fields.length ? fields.filter(name => columns.includes(name)) : null;
      const totalCount = db.prepare(`SELECT count(*) AS n FROM records WHERE ${sql}`).get(...params).n;
      const rows = db.prepare(`SELECT key, json FROM records WHERE ${sql} ORDER BY at DESC, key LIMIT ?`).all(...params, limitOf(limit, MAX_LIMIT));
      const records = rows.map(row => {
        const record = JSON.parse(row.json);
        const picked = wanted ? Object.fromEntries(wanted.map(name => [name, record[name]])) : record;
        return { key: row.key, ...Object.fromEntries(Object.entries(picked).filter(([, value]) => value !== null && value !== '')) };
      });
      return { className: entry.class, asOf: entry.as_of, totalCount, records };
    },

    /**
     * Counts of matching records grouped by one field, largest first.
     * @returns {{className, asOf, totalCount, groupBy, groups: {value, count}[]} | {gap}}
     */
    count(className, { filters = [], groupBy = null, limit } = {}) {
      const checked = check(className);
      if (checked.gap) return checked;
      const { entry, columns } = checked;
      const { sql, params } = where(entry, columns, filters);
      const totalCount = db.prepare(`SELECT count(*) AS n FROM records WHERE ${sql}`).get(...params).n;
      if (!groupBy) return { className: entry.class, asOf: entry.as_of, totalCount, groupBy: null, groups: [] };
      if (!columns.includes(groupBy)) throw new TypeError(`'${groupBy}' is not a field of ${entry.class}.`);
      const groups = db.prepare(`SELECT CAST(json_extract(json, ?) AS TEXT) AS value, count(*) AS count FROM records WHERE ${sql}
        GROUP BY value ORDER BY count DESC, value LIMIT ?`).all(`$."${groupBy}"`, ...params, limitOf(limit, MAX_GROUPS));
      return { className: entry.class, asOf: entry.as_of, totalCount, groupBy, groups: groups.map(row => ({ value: row.value, count: row.count })) };
    },

    close: () => db?.close(),
  };
}
