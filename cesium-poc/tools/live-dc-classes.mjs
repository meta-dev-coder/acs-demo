#!/usr/bin/env node
/**
 * Regenerates the admin artifacts for the Live DataConnect classes under config/liveDc/.
 * No network: the admin applies these by hand (POST /class, then POST /class/{id} with `add`).
 *
 *   node tools/live-dc-classes.mjs            write the committed artifacts
 *   node tools/live-dc-classes.mjs --check    exit 1 when a committed artifact has drifted
 *   node tools/live-dc-classes.mjs --link-mode none --out <file>   ad-hoc create-requests variant
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  HISTORICAL_CLASSES, LINK_MODES, LIVE_RELATIONSHIP_TYPES, isLiveClassName,
  buildCreateRequests, buildRelationshipTypesDelta, buildClassReference,
} from '../server/liveDc/classes.mjs';

const CONFIG_DIR = fileURLToPath(new URL('../config/liveDc/', import.meta.url));
const HISTORICAL_ID_BY_NAME = new Map(HISTORICAL_CLASSES.map((c) => [c.className, c.id]));

// Live ids only exist once the admin has created the classes, so they are substituted in load order.
function createRequestResolver(className) {
  if (HISTORICAL_ID_BY_NAME.has(className)) return HISTORICAL_ID_BY_NAME.get(className);
  if (isLiveClassName(className)) return `<id of ${className}>`;
  throw new Error(`unknown relationship target class '${className}'`);
}

const toJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

function relationshipTypesFile() {
  return {
    ...buildRelationshipTypesDelta({ linkMode: 'live' }),
    linkedOnlyNote: "Append these as well ONLY when using link mode 'linked' (live-classes.create-requests.linked.json).",
    linkedOnly: LIVE_RELATIONSHIP_TYPES.filter((t) => t.linkedOnly)
      .map(({ type, externalLabel, internalLabel, order }) => ({ type, externalLabel, internalLabel, order })),
  };
}

export function generateArtifacts() {
  return {
    'live-classes.create-requests.json': toJson(buildCreateRequests({ resolveClassId: createRequestResolver, linkMode: 'live' })),
    'live-classes.create-requests.linked.json': toJson(buildCreateRequests({ resolveClassId: createRequestResolver, linkMode: 'linked' })),
    'live-relationship-types.json': toJson(relationshipTypesFile()),
    'live-classes.reference.json': toJson(buildClassReference({ linkMode: 'live' })),
  };
}

function parseArgs(argv) {
  const args = { check: false, linkMode: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') args.check = true;
    else if (arg === '--link-mode') args.linkMode = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else throw new Error(`unknown argument '${arg}'`);
  }
  if (args.linkMode && !LINK_MODES.includes(args.linkMode)) throw new Error(`--link-mode must be one of ${LINK_MODES.join(', ')}`);
  if (Boolean(args.linkMode) !== Boolean(args.out)) throw new Error('--link-mode and --out must be given together');
  return args;
}

const readOrNull = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };

function main(argv) {
  const args = parseArgs(argv);
  if (args.out) {
    const out = resolve(process.cwd(), args.out);
    writeFileSync(out, toJson(buildCreateRequests({ resolveClassId: createRequestResolver, linkMode: args.linkMode })));
    console.log(`wrote ${out} (link mode ${args.linkMode})`);
    return 0;
  }
  const drifted = [];
  for (const [name, content] of Object.entries(generateArtifacts())) {
    const path = resolve(CONFIG_DIR, name);
    if (readOrNull(path) === content) continue;
    if (args.check) drifted.push(name);
    else { writeFileSync(path, content); console.log(`wrote config/liveDc/${name}`); }
  }
  if (args.check && drifted.length) {
    console.error(`Live DataConnect artifacts out of date: ${drifted.join(', ')}. Run: node tools/live-dc-classes.mjs`);
    return 1;
  }
  if (args.check) console.log('Live DataConnect artifacts up to date');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
