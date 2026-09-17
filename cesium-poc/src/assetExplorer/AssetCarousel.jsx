/**
 * The horizontal card list, with Previous/Next.
 *
 * Next/Previous only change the selection. They do not fly the camera in close — §6 and §26 both
 * separate browsing from inspecting, and stepping through a corridor should not feel like being
 * thrown at each asset in turn.
 */
import { useMemo } from 'react';
import { Box, IconButton, Skeleton, Stack, Tooltip, Typography } from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { AssetCard } from './AssetCard.jsx';
import { cardWindowStart, VISIBLE_CARDS } from './carouselWindow.js';

export { cardWindowStart, VISIBLE_CARDS };

export function AssetCarousel({ assets, selectedAsset, singular, status, emptyMessage, errorMessage, onSelect, onStep }) {
  const index = selectedAsset ? assets.findIndex(asset => asset.id === selectedAsset.id) : -1;
  // Derived from the selection rather than held as state, so a selection arriving from Cesium, the
  // mini-map or the rail brings its card on screen by construction — there is no scroll to sync.
  const start = useMemo(() => cardWindowStart(assets.length, index), [assets.length, index]);
  const visible = assets.slice(start, start + VISIBLE_CARDS);

  if (status.error) {
    return <Typography variant="body2" color="error.main" sx={{ px: 1.5, py: 3 }}>{errorMessage}</Typography>;
  }
  if (status.loading) {
    return (
      <Stack direction="row" spacing={1} sx={{ px: 1.5, py: 1 }} aria-busy="true" aria-label="Loading assets">
        {Array.from({ length: VISIBLE_CARDS }, (_, i) => (
          <Skeleton key={i} variant="rounded" sx={{ flex: 1 }} height={78} />
        ))}
      </Stack>
    );
  }
  if (!assets.length) {
    // An honest empty state, never a placeholder asset.
    return <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, py: 3 }}>{emptyMessage}</Typography>;
  }

  return (
    <Stack direction="row" alignItems="center" spacing={0.5} sx={{ px: 0.5 }}>
      <Tooltip title={`Previous ${singular.toLowerCase()}`}>
        {/* A disabled button cannot host a tooltip, so it needs this wrapper — and the wrapper
            stretches to the row height, which left the chevron sitting at the top of the cards.
            Centring happens inside it rather than relying on the row's alignment. */}
        <Box component="span" sx={{ display: 'flex', alignItems: 'center' }}>
          <IconButton onClick={() => onStep(-1)} disabled={index <= 0} aria-label={`Previous ${singular.toLowerCase()}`}>
            <ChevronLeftIcon />
          </IconButton>
        </Box>
      </Tooltip>
      {/* Exactly VISIBLE_CARDS on screen, sharing the width evenly — no horizontal scrollbar to
          chase, and the Previous/Next buttons are the only way through the list. */}
      <Box sx={{ display: 'grid', gridTemplateColumns: `repeat(${VISIBLE_CARDS}, 1fr)`, gap: 1, flex: 1, py: 1, px: 0.5 }}>
        {visible.map(asset => (
          <AssetCard
            key={asset.id}
            asset={asset}
            selected={asset.id === selectedAsset?.id}
            onSelect={onSelect}
          />
        ))}
      </Box>
      <Tooltip title={`Next ${singular.toLowerCase()}`}>
        <Box component="span" sx={{ display: 'flex', alignItems: 'center' }}>
          <IconButton onClick={() => onStep(1)} disabled={index >= assets.length - 1} aria-label={`Next ${singular.toLowerCase()}`}>
            <ChevronRightIcon />
          </IconButton>
        </Box>
      </Tooltip>
    </Stack>
  );
}
