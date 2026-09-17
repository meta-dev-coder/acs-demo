/**
 * One asset in the carousel. Compact by design: an operator scans these, they do not read them.
 *
 * Every field comes from the type's configuration, so a card never hard-codes what a gantry or a
 * camera looks like — and a field the source record does not carry is simply absent.
 */
import { memo } from 'react';
import { Box, Card, CardActionArea, Stack, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircleOutlined';
import { assetTypeConfig } from './assetTypes.js';
import { AssetTypeIcon } from './AssetTypeIcon.jsx';

const TONE_COLOR = { ok: 'success.main', warn: 'warning.main', muted: 'text.secondary' };

function AssetCardBase({ asset, selected, onSelect }) {
  const config = assetTypeConfig(asset.assetType);
  const subtitle = config?.getSubtitle(asset) ?? null;
  const status = config?.getStatus(asset) ?? null;
  return (
    <Card
      elevation={selected ? 3 : 0}
      sx={{
        minWidth: 0,
        // Restrained selection: the primary colour as a border and a tonal wash, no glow.
        borderColor: selected ? 'primary.main' : 'divider',
        borderWidth: selected ? 2 : 1,
        bgcolor: selected ? 'action.selected' : 'background.paper',
      }}
    >
      <CardActionArea
        onClick={() => onSelect(asset)}
        aria-label={`Select ${asset.name}`}
        aria-current={selected ? 'true' : undefined}
        sx={{ p: 1.25, height: '100%', alignItems: 'stretch' }}
      >
        <Stack spacing={0.75}>
          <Stack direction="row" alignItems="center" spacing={0.75}>
            <AssetTypeIcon assetType={asset.assetType} fontSize="small" sx={{ color: selected ? 'primary.main' : 'text.secondary' }} />
            <Typography variant="subtitle2" noWrap sx={{ flex: 1 }}>{config?.getTitle(asset) ?? asset.name}</Typography>
            {/* Selection is not signalled by colour alone. */}
            {selected && <CheckCircleIcon fontSize="small" color="primary" aria-hidden />}
          </Stack>
          {subtitle && (
            <Typography variant="caption" color="text.secondary" noWrap title={subtitle}>{subtitle}</Typography>
          )}
          {status && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: TONE_COLOR[status.tone] ?? 'text.secondary' }} aria-hidden />
              <Typography variant="caption" sx={{ color: TONE_COLOR[status.tone] ?? 'text.secondary' }} noWrap>
                {status.label}
              </Typography>
            </Box>
          )}
        </Stack>
      </CardActionArea>
    </Card>
  );
}

// The carousel re-renders on every selection change; only the two cards whose selected state
// actually flipped should re-render with it.
export const AssetCard = memo(AssetCardBase,
  (a, b) => a.asset === b.asset && a.selected === b.selected && a.onSelect === b.onSelect);
