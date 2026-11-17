/**
 * Conversation memory, and the one rule that matters: never guess what "this" means.
 *
 * A follow-up like "what cameras are near it?" only makes sense against something. There are three
 * places that something can come from, in this order:
 *
 *   1. the name in the question itself     — "cameras near Terminal A"
 *   2. what is selected on the map now     — the app's existing selection, read through the context
 *   3. what this conversation last resolved — the subject of the previous answer
 *
 * If none of them yields a subject, the assistant ASKS. It does not fall back to the port centre,
 * the camera position, or the first terminal in the registry, because a confident answer about the
 * wrong terminal is worse than a question.
 *
 * The session holds subjects and result ids — never credentials, and never tool payloads that
 * could make a past answer look re-verified. Clearing the conversation clears all of it.
 */
import { searchInfrastructureAssets, anchorFor } from './tools.js';
import { displayName } from '../roads/roadModel.js';

export const SUBJECT = Object.freeze({
  ASSET: 'ASSET', ROAD: 'ROAD', BUILDING: 'BUILDING', PORT: 'PORT',
});

export const createSession = () => Object.freeze({
  lastAssetId: null,
  lastRoadObjectId: null,
  lastBuildingObjectId: null,
  lastIntent: null,
  /** Ids the previous answer named, so "show them on the map" has something to act on. */
  lastResults: Object.freeze({ buildings: [], roads: [], cameras: [], events: [], assets: [] }),
  lastSubjectLabel: null,
});

/** What the question is about, when the question itself says so. */
const mentions = (slots, word) => new RegExp(`\\b${word}s?\\b`, 'i').test(slots.anchorText ?? slots.raw ?? '');

/**
 * Resolve the subject of a question.
 *
 * @returns {{ok: true, kind, label, assetId?, objectId?, point?, pointStatus?}}
 *        | {ok: false, needs: 'NAME'|'SELECTION'|'CHOICE', message, options?}
 */
export function resolveSubject({ slots, context, memory, view }) {
  // 1. A name in the question wins. It is the only unambiguous signal.
  if (slots?.name) {
    const found = searchInfrastructureAssets(view, slots.name);
    if (!found.ok) {
      return { ok: false, needs: 'NAME', message: `I couldn’t find “${slots.name}” in the infrastructure registry.` };
    }
    if (found.matches.length > 1) {
      return {
        ok: false, needs: 'CHOICE',
        message: `“${slots.name}” matches ${found.matches.length} records — `
          + `${found.matches.map(a => a.name).join(', ')}. Which one do you mean?`,
        options: found.matches.map(asset => ({ assetId: asset.id, label: asset.name })),
      };
    }
    const asset = found.matches[0];
    const where = anchorFor(view, asset);
    return {
      ok: true, kind: SUBJECT.ASSET, assetId: asset.id, label: asset.name, asset,
      point: where?.point ?? null, pointStatus: where?.status ?? null, pointBasis: where?.basis ?? null,
    };
  }

  // 2. The current selection, preferring whatever kind the question names.
  const resolved = context?.resolved ?? {};
  const wantsRoad = mentions(slots ?? {}, 'road') || mentions(slots ?? {}, 'street');
  const wantsBuilding = mentions(slots ?? {}, 'building') || mentions(slots ?? {}, 'footprint');
  const order = wantsRoad ? ['road', 'asset', 'building']
    : wantsBuilding ? ['building', 'asset', 'road']
      : ['asset', 'road', 'building'];

  for (const kind of order) {
    if (kind === 'asset' && resolved.asset) {
      return {
        ok: true, kind: SUBJECT.ASSET, assetId: resolved.asset.id, label: resolved.asset.name,
        asset: resolved.asset, point: context.resolved.assetPoint,
        pointStatus: context.resolved.assetPointStatus,
      };
    }
    if (kind === 'road' && resolved.road) {
      return {
        ok: true, kind: SUBJECT.ROAD, objectId: resolved.road.objectId,
        label: displayName(resolved.road), road: resolved.road, point: resolved.road.midpoint ?? null,
      };
    }
    if (kind === 'building' && resolved.building) {
      return {
        ok: true, kind: SUBJECT.BUILDING, objectId: resolved.building.objectId,
        label: `Building · ID ${resolved.building.objectId}`, building: resolved.building,
        point: resolved.building.centroid ?? null,
      };
    }
  }

  // 3. What this conversation last resolved.
  if (memory?.lastAssetId) {
    const asset = view.assets?.find(a => a.id === memory.lastAssetId);
    if (asset) {
      const where = anchorFor(view, asset);
      return {
        ok: true, kind: SUBJECT.ASSET, assetId: asset.id, label: asset.name, asset,
        point: where?.point ?? null, pointStatus: where?.status ?? null, fromMemory: true,
      };
    }
  }
  if (memory?.lastRoadObjectId != null) {
    const road = view.roadsById?.get(memory.lastRoadObjectId);
    if (road) {
      return {
        ok: true, kind: SUBJECT.ROAD, objectId: road.objectId, label: displayName(road), road,
        point: road.midpoint ?? null, fromMemory: true,
      };
    }
  }

  // 4. Ask.
  return {
    ok: false, needs: 'SELECTION',
    message: 'I don’t know what “' + (slots?.anchorText?.trim() || 'this') + '” refers to. '
      + 'Select an asset, road or building on the map, or name one in the question.',
  };
}

/** Fold an answer back into the session. Ids only — never tool payloads. */
export function rememberAnswer(memory, { intent, subject, results }) {
  const base = memory ?? createSession();
  return Object.freeze({
    ...base,
    lastIntent: intent ?? base.lastIntent,
    lastAssetId: subject?.kind === SUBJECT.ASSET ? subject.assetId : base.lastAssetId,
    lastRoadObjectId: subject?.kind === SUBJECT.ROAD ? subject.objectId : base.lastRoadObjectId,
    lastBuildingObjectId: subject?.kind === SUBJECT.BUILDING ? subject.objectId : base.lastBuildingObjectId,
    lastSubjectLabel: subject?.label ?? base.lastSubjectLabel,
    lastResults: Object.freeze({
      buildings: results?.buildings ?? base.lastResults.buildings,
      roads: results?.roads ?? base.lastResults.roads,
      cameras: results?.cameras ?? base.lastResults.cameras,
      events: results?.events ?? base.lastResults.events,
      assets: results?.assets ?? base.lastResults.assets,
    }),
  });
}
