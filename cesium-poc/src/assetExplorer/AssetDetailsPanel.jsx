/**
 * Right-hand details panel for the selected asset.
 *
 * Schema driven: every row comes from the type's `details()` and anything the source record does not
 * carry is dropped rather than rendered empty. Actions are likewise only rendered when the asset can
 * actually support them — no disabled buttons padding out the panel.
 */
import { Fragment, useEffect, useRef } from 'react';
import { Box, Button, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import MyLocationOutlinedIcon from '@mui/icons-material/MyLocationOutlined';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import VideocamOutlinedIcon from '@mui/icons-material/VideocamOutlined';
import { assetTypeConfig, detailRows } from './assetTypes.js';
import { makeDraggable } from '../draggablePanel.js';

export const DETAILS_WIDTH = 310;

export function AssetDetailsPanel({ asset, inspecting, onClose, onInspect, onReturn, onViewCamera, top = 220, bottom = 16, right = 16 }) {
  const panelRef = useRef(null);
  const headingRef = useRef(null);

  // Every details panel on this map floats — the corridor ones already did (mapDetailsPanel.js), and
  // this one is the same family. The heading is the grab handle, so a record's details can be moved
  // off whatever they are covering; the Close button inside it stays clickable. Hooks run before the
  // early return below, because a hook may not sit behind a condition.
  useEffect(() => {
    if (!panelRef.current || !headingRef.current) return undefined;
    const drag = makeDraggable(panelRef.current, headingRef.current);
    return () => drag.destroy();
  }, [Boolean(asset)]);

  if (!asset) return null;
  const config = assetTypeConfig(asset.assetType);
  const status = config?.getStatus(asset) ?? null;
  // Status is a row like any other, so the panel reads as one definition list rather than a
  // heading, a loose caption and then a list — which is what made it look unlike the camera panel.
  const rows = [...(status ? [['Status', status.label]] : []), ...detailRows(asset)];
  const title = config?.detailsTitle ?? `${config?.singular ?? 'Asset'} Details`;
  const canViewCamera = asset.assetType === 'camera' && asset.source?.video_enabled === true && Boolean(onViewCamera);

  return (
    <Paper
      ref={panelRef}
      elevation={4}
      sx={{
        // Matches the existing corridor details panels (.camera-details and friends): same column,
        // same width, same padding and radius, so the two kinds of panel are visibly one family.
        position: 'absolute', right, top, width: DETAILS_WIDTH,
        maxHeight: `calc(100% - ${top + bottom}px)`,
        p: 2.25, borderRadius: 2, overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: 1.5, pointerEvents: 'auto',
      }}
      role="complementary"
      aria-label={title}
    >
      <Stack ref={headingRef} direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
        {/* The title takes the remaining width so the close button sits hard against the top-right
            corner, whatever the title's length. */}
        <Typography component="h2" sx={{ flex: 1, minWidth: 0, fontSize: 17, fontWeight: 600, lineHeight: 1.25 }}>
          {title}
        </Typography>
        <Tooltip title="Close asset details">
          <IconButton
            onClick={onClose}
            aria-label="Close asset details"
            sx={{ width: 36, height: 36, borderRadius: 1, bgcolor: 'action.hover', flex: 'none' }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {/* The same two-column definition grid the existing panels use. */}
      <Box
        component="dl"
        sx={{
          display: 'grid', gridTemplateColumns: '90px 1fr', gap: 1.5,
          m: 0, fontSize: 12, lineHeight: 1.5,
        }}
      >
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <Box component="dt" sx={{ color: 'text.secondary' }}>{label}</Box>
            <Box component="dd" sx={{ m: 0, overflowWrap: 'anywhere' }}>{value}</Box>
          </Fragment>
        ))}
      </Box>

      {rows.length === 0 && (
        <Typography variant="body2" color="text.secondary">This record carries no further details.</Typography>
      )}

      <Stack spacing={1}>
        <Button
          variant="contained"
          startIcon={<MyLocationOutlinedIcon />}
          onClick={() => onInspect(asset)}
          disabled={!asset.coordinates}
          aria-label={`View ${asset.name} on map`}
        >
          View on map
        </Button>
        {canViewCamera && (
          <Button variant="outlined" startIcon={<VideocamOutlinedIcon />} onClick={() => onViewCamera(asset)}
            aria-label={`Open camera for ${asset.name}`}>
            View camera
          </Button>
        )}
        {inspecting && (
          <Button variant="text" startIcon={<ArrowBackOutlinedIcon />} onClick={onReturn}
            aria-label="Return to the previous view">
            Back to corridor view
          </Button>
        )}
      </Stack>
    </Paper>
  );
}
