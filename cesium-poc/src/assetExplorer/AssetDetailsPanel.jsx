/**
 * Right-hand details panel for the selected asset.
 *
 * Schema driven: every row comes from the type's `details()` and anything the source record does not
 * carry is dropped rather than rendered empty. Actions are likewise only rendered when the asset can
 * actually support them — no disabled buttons padding out the panel.
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { Box, Button, IconButton, Paper, Stack, Tab, Tabs, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import MyLocationOutlinedIcon from '@mui/icons-material/MyLocationOutlined';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import VideocamOutlinedIcon from '@mui/icons-material/VideocamOutlined';
import { assetTypeConfig, detailRows } from './assetTypes.js';
import { makeDraggable } from '../draggablePanel.js';
import { RelatedRecords, relatedRecordCount, useRelatedGroups } from './RelatedRecords.jsx';

export const DETAILS_WIDTH = 310;

export function AssetDetailsPanel({
  asset, inspecting, onClose, onInspect, onReturn, onViewCamera,
  lookupRecords = null, onOpenRecord = null,
  top = 220, bottom = 16, right = 16,
}) {
  const panelRef = useRef(null);
  const headingRef = useRef(null);
  const [tab, setTab] = useState(0);
  // A maintenance record is one class's view of something the other classes also wrote about; every
  // other asset type stands alone, so only these are offered the Related tab.
  const related = useRelatedGroups(asset?.source?.type ? asset.source : null, lookupRecords);
  const relatedTotal = relatedRecordCount(related);

  // Every details panel on this map floats — the corridor ones already did (mapDetailsPanel.js), and
  // this one is the same family. The heading is the grab handle, so a record's details can be moved
  // off whatever they are covering; the Close button inside it stays clickable. Hooks run before the
  // early return below, because a hook may not sit behind a condition.
  useEffect(() => {
    if (!panelRef.current || !headingRef.current) return undefined;
    const drag = makeDraggable(panelRef.current, headingRef.current);
    return () => drag.destroy();
  }, [Boolean(asset)]);

  // Moving to another asset must not leave the panel on a tab about the previous one.
  useEffect(() => { setTab(0); }, [asset?.assetType, asset?.id]);

  if (!asset) return null;
  const config = assetTypeConfig(asset.assetType);
  const status = config?.getStatus(asset) ?? null;
  // Status is a row like any other, so the panel reads as one definition list rather than a
  // heading, a loose caption and then a list — which is what made it look unlike the camera panel.
  const rows = [...(status ? [['Status', status.label]] : []), ...detailRows(asset)];
  const title = config?.detailsTitle ?? `${config?.singular ?? 'Asset'} Details`;
  const canViewCamera = asset.assetType === 'camera' && asset.source?.video_enabled === true && Boolean(onViewCamera);
  const showRelated = Boolean(lookupRecords) && Boolean(asset.source?.type);
  const openRelated = onOpenRecord ? reference => { void onOpenRecord(reference.assetType, reference.id); } : null;

  return (
    <Paper
      ref={panelRef}
      elevation={4}
      sx={{
        // Matches the existing corridor details panels (.camera-details and friends): same column,
        // same width, same padding and radius, so the two kinds of panel are visibly one family.
        position: 'absolute', right, top, width: DETAILS_WIDTH, zIndex: 60,
        maxHeight: `calc(100% - ${top + bottom}px)`,
        // The heading is pinned and the body scrolls under it, so Close and the record's name stay
        // on screen however long the Related tab gets. Padding lives on the two sections instead.
        p: 0, borderRadius: 2, overflow: 'hidden',
        display: 'flex', flexDirection: 'column', pointerEvents: 'auto',
      }}
      role="complementary"
      aria-label={title}
    >
      <Stack
        ref={headingRef}
        direction="row"
        spacing={1}
        sx={{
          position: 'relative', flex: 'none', alignItems: 'flex-start',
          px: 2.25, pt: 2.25, pb: 1.5, pr: 6.5, borderBottom: 1, borderColor: 'divider',
        }}
      >
        <Typography component="h2" sx={{ flex: 1, minWidth: 0, fontSize: 17, fontWeight: 600, lineHeight: 1.25 }}>
          {title}
        </Typography>
        <Tooltip title="Close asset details">
          {/* The panel's top-right corner, pinned: a drag handle ignores clicks on a button, so
              this stays clickable while the heading still moves the panel. */}
          <IconButton
            onClick={onClose}
            aria-label="Close asset details"
            sx={{ position: 'absolute', top: 10, right: 10, width: 36, height: 36, borderRadius: 1, bgcolor: 'action.hover' }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {/* Everything below the heading scrolls. */}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 2.25, display: 'flex', flexDirection: 'column', gap: 1.5 }}>

      {showRelated && (
        <Tabs
          value={tab}
          onChange={(event, next) => setTab(next)}
          variant="fullWidth"
          sx={{ minHeight: 34, borderBottom: 1, borderColor: 'divider', '& .MuiTab-root': { minHeight: 34, fontSize: 12.5, py: 0 } }}
        >
          <Tab label="Details" />
          <Tab label={`Related (${relatedTotal})`} />
        </Tabs>
      )}

      {tab === 0 && (
        <>
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
        </>
      )}

      {showRelated && tab === 1 && <RelatedRecords groups={related} onOpen={openRelated} />}

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
      </Box>
    </Paper>
  );
}
