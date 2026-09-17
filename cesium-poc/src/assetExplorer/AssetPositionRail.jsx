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

function AssetPositionRailBase({ assets, selectedId, corridorMiles, onSelect }) {
  const placed = useMemo(
    () => assets.filter(asset => Number.isFinite(asset.corridorFraction)),
    [assets]);
  if (placed.length < 2) return null;

  return (
    <Box sx={{ px: 1, pt: 0.5 }}>
      <Box sx={{ position: 'relative', height: 22 }}>
        <Box sx={{ position: 'absolute', left: 0, right: 0, top: 10, height: 2, bgcolor: 'divider', borderRadius: 1 }} aria-hidden />
        {placed.map(asset => {
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
                  left: `${Math.min(100, Math.max(0, asset.corridorFraction * 100))}%`,
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
