/**
 * Corridor position rail — where the browsed assets sit along I-595.
 *
 * Laid out by fraction along the centerline, never by mixing measurement scales: the bridge dataset
 * publishes FDOT mileposts, the camera dataset publishes none, and the two differ by about three
 * miles (see normalizeAsset). Ticks are therefore placed geometrically and *labelled* with whatever
 * the asset genuinely has.
 *
 * Rendered only when the assets carry usable corridor positions — §7's "if it does not exist, omit".
 */
import { memo, useMemo } from 'react';
import { Box, Tooltip, Typography } from '@mui/material';
import { positionLabel } from './assetTypes.js';

/**
 * Above this many assets the rail stops drawing one tooltip'd button per asset. 2,895 lighting assets
 * on a 700px rail are several to a pixel — 2,895 MUI tooltips cost about a second per selection and
 * show nothing more than a density band would. Every asset stays reachable: each bin selects its
 * first asset, and the carousel and Previous/Next still walk the full list.
 */
export const DENSE_RAIL_THRESHOLD = 150;
const DENSE_BINS = 240;

const fractionLeft = fraction => `${Math.min(100, Math.max(0, fraction * 100))}%`;

/** Ticks only — memoized on the list, so a selection change never re-renders them. */
const DenseTicks = memo(function DenseTicks({ placed, onSelect }) {
  const bins = useMemo(() => {
    const byBin = new Map();
    for (const asset of placed) {
      const bin = Math.min(DENSE_BINS - 1, Math.max(0, Math.floor(asset.corridorFraction * DENSE_BINS)));
      const entry = byBin.get(bin);
      if (entry) entry.count++; else byBin.set(bin, { bin, first: asset, count: 1 });
    }
    return [...byBin.values()];
  }, [placed]);
  return bins.map(({ bin, first, count }) => (
    <Box
      key={bin}
      component="button"
      type="button"
      title={count > 1 ? `${count} assets here — select ${first.name}` : first.name}
      aria-label={`Select ${first.name}`}
      onClick={() => onSelect(first)}
      sx={{
        position: 'absolute', top: 6, left: fractionLeft((bin + 0.5) / DENSE_BINS), transform: 'translateX(-50%)',
        width: 4, height: 10, p: 0, border: 0, cursor: 'pointer', borderRadius: 0.5,
        bgcolor: 'text.secondary', opacity: count > 1 ? 1 : 0.6, '&:hover': { bgcolor: 'primary.light' },
      }}
    />
  ));
});

function AssetPositionRailBase({ assets, selectedId, corridorMiles, onSelect }) {
  const placed = useMemo(
    () => assets.filter(asset => Number.isFinite(asset.corridorFraction)),
    [assets]);
  if (placed.length < 2) return null;
  const dense = placed.length > DENSE_RAIL_THRESHOLD;
  const selectedAsset = dense && selectedId != null ? placed.find(asset => asset.id === selectedId) : null;

  return (
    <Box sx={{ px: 1, pt: 0.5 }}>
      <Box sx={{ position: 'relative', height: 22 }}>
        <Box sx={{ position: 'absolute', left: 0, right: 0, top: 10, height: 2, bgcolor: 'divider', borderRadius: 1 }} aria-hidden />
        {dense && <DenseTicks placed={placed} onSelect={onSelect} />}
        {dense && selectedAsset && (
          <Box
            aria-hidden
            sx={{
              position: 'absolute', top: 3, left: fractionLeft(selectedAsset.corridorFraction), transform: 'translateX(-50%)',
              width: 10, height: 16, borderRadius: 1, bgcolor: 'primary.main', pointerEvents: 'none',
            }}
          />
        )}
        {!dense && placed.map(asset => {
          const selected = asset.id === selectedId;
          const label = positionLabel(asset);
          return (
            <Tooltip key={asset.id} title={label ? `${asset.name} · ${label}` : asset.name}>
              <Box
                component="button"
                type="button"
                aria-label={`Select ${asset.name}`}
                onClick={() => onSelect(asset)}
                sx={{
                  position: 'absolute', top: selected ? 3 : 6,
                  left: fractionLeft(asset.corridorFraction),
                  transform: 'translateX(-50%)',
                  width: selected ? 10 : 8, height: selected ? 16 : 10,
                  p: 0, border: 0, cursor: 'pointer', borderRadius: selected ? 1 : '50%',
                  bgcolor: selected ? 'primary.main' : 'text.secondary',
                  '&:hover': { bgcolor: 'primary.light' },
                }}
              />
            </Tooltip>
          );
        })}
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
        <Typography variant="caption" color="text.secondary">0 mi</Typography>
        <Typography variant="caption" color="text.secondary">{corridorMiles.toFixed(1)} mi</Typography>
      </Box>
    </Box>
  );
}

export const AssetPositionRail = memo(AssetPositionRailBase);
