/**
 * The infrastructure registry, resolved against the loaded GIS, with the reviewer's links.
 *
 * Reuses everything already in place: the road and building records the other two hooks loaded,
 * their Cesium layers for highlighting and flying, and the shared selection in App. It adds no
 * second copy of the GIS and no second selection engine.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  assetIds, linkFromMapSelection, linksByAsset, linksFor, proposedLinks, resolveAssets,
  summariseAssets,
} from '../infrastructure/assetModel.js';
import { LINK_STATUS, reviewEntry, roadLink } from '../infrastructure/assetLinks.js';
import { loadLinks, reconcileLinks, saveLinks } from '../infrastructure/assetStore.js';

export function useInfrastructure({ segments, buildings }) {
  const [store, setStore] = useState(() => loadLinks());
  const [selectedAssetId, setSelectedAssetId] = useState(null);
  const [linkMode, setLinkMode] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const [integrity, setIntegrity] = useState({ dropped: 0, flagged: 0, notes: [] });

  const assets = useMemo(() => resolveAssets({ segments, buildings }), [segments, buildings]);

  // Validate stored links against what actually loaded. A link pointing at a vanished OBJECTID is
  // flagged, never silently re-pointed at whatever feature now holds that id.
  useEffect(() => {
    if (segments.length === 0 || buildings.length === 0) return;
    const result = reconcileLinks(store, {
      assetIds: assetIds(),
      buildingIds: new Set(buildings.map(b => b.objectId)),
      roadIds: new Set(segments.map(s => s.objectId)),
    });
    setIntegrity({ dropped: result.dropped, flagged: result.flagged, notes: result.notes });
    if (result.dropped > 0 || result.flagged > 0) setStore(result.state);
    // Runs when the GIS arrives; the store is written by the actions below, not by this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, buildings]);

  const proposed = useMemo(() => proposedLinks(assets), [assets]);
  const index = useMemo(() => linksByAsset(store, proposed), [store, proposed]);
  const summary = useMemo(() => summariseAssets(assets, index), [assets, index]);
  const selected = useMemo(
    () => assets.find(asset => asset.id === selectedAssetId) ?? null, [assets, selectedAssetId]);

  /** Persist and keep the in-memory copy in step. One place writes storage. */
  const commit = useCallback(next => {
    setStore(next);
    setStorageOk(saveLinks(next));
  }, []);

  /** A proposal only becomes a stored row when a reviewer touches it. */
  const upsert = useCallback((link, kind, status, note) => {
    const key = kind === 'building' ? 'buildingLinks' : 'roadLinks';
    const idKey = kind === 'building' ? 'buildingObjectId' : 'roadObjectId';
    setStore(current => {
      const rest = current[key].filter(
        existing => !(existing.assetId === link.assetId && existing[idKey] === link[idKey]));
      const previous = current[key].find(
        existing => existing.assetId === link.assetId && existing[idKey] === link[idKey]);
      const saved = { ...link, id: previous?.id ?? link.id, status, reviewedAt: new Date().toISOString() };
      const next = {
        ...current,
        [key]: [...rest, saved],
        history: [...current.history, reviewEntry({
          linkId: saved.id, assetId: saved.assetId, kind, objectId: saved[idKey],
          from: previous?.status ?? 'PROPOSED', to: status, note: note ?? null,
        })].slice(-300),
      };
      setStorageOk(saveLinks(next));
      return next;
    });
  }, []);

  const confirmLink = useCallback((link, kind) => upsert(link, kind, LINK_STATUS.CONFIRMED), [upsert]);
  const rejectLink = useCallback((link, kind) => upsert(link, kind, LINK_STATUS.REJECTED), [upsert]);

  /** Remove a reviewer's row entirely, returning the pair to whatever the build proposes. */
  const unlink = useCallback((link, kind) => {
    const key = kind === 'building' ? 'buildingLinks' : 'roadLinks';
    setStore(current => {
      const next = { ...current, [key]: current[key].filter(existing => existing.id !== link.id) };
      setStorageOk(saveLinks(next));
      return next;
    });
  }, []);

  /** "Link Building": the reviewer picked a footprint on the map for the selected asset. */
  const linkBuilding = useCallback((assetId, buildingObjectId, relationship = 'PRIMARY_FOOTPRINT') => {
    upsert(linkFromMapSelection(assetId, buildingObjectId, relationship), 'building', LINK_STATUS.CONFIRMED);
    setLinkMode(false);
  }, [upsert]);

  /** Promote a nearby road to a real link at the relationship the reviewer chose. */
  const linkRoad = useCallback((assetId, roadObjectId, relationship, evidence) => {
    upsert(roadLink({
      assetId, roadObjectId, relationship, matchMethod: 'MAP_SELECTION', evidence,
    }), 'road', LINK_STATUS.CONFIRMED);
  }, [upsert]);

  /** What the map should emphasise for the selected asset. */
  const emphasis = useMemo(() => {
    const roads = new Map(), buildingIds = new Map();
    if (!selected) return { roads, buildings: buildingIds };
    const { buildingLinks, roadLinks } = linksFor(index, selected.id);
    for (const link of roadLinks) {
      if (link.status === LINK_STATUS.CONFIRMED) roads.set(link.roadObjectId, 'CONFIRMED');
      else if (link.status === LINK_STATUS.CANDIDATE) roads.set(link.roadObjectId, 'CANDIDATE');
    }
    for (const link of buildingLinks) {
      if (link.status === LINK_STATUS.CONFIRMED) buildingIds.set(link.buildingObjectId, 'CONFIRMED');
      else if (link.status === LINK_STATUS.CANDIDATE) buildingIds.set(link.buildingObjectId, 'CANDIDATE');
    }
    return { roads, buildings: buildingIds };
  }, [selected, index]);

  return {
    assets, index, summary, selected, selectedAssetId, integrity, storageOk, store,
    select: setSelectedAssetId,
    clearSelection: () => setSelectedAssetId(null),
    linkMode, setLinkMode,
    confirmLink, rejectLink, unlink, linkBuilding, linkRoad,
    emphasis,
    linksFor: id => linksFor(index, id),
  };
}
