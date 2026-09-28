/**
 * The details panel for one incident.
 *
 * An incident is not another row of asset metadata — it is an event an operator has to act on — so
 * it gets its own surface rather than the shared definition list: the type's own colour and
 * pictogram, the nearest camera looking at it, the two or three numbers that decide the response,
 * and the record's own columns behind tabs.
 *
 * Everything on it is measured or quoted. The carriageway, the milepost and the cameras are
 * resolved from the incident's coordinates against the corridor's published geometry
 * (`incidentContext.js`); the prose comes from the record's own columns (`incidentNarrative.js`).
 * The one exception is Recommended next steps, which is explicitly a placeholder and says so.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Chip, IconButton, Paper, Stack, Tab, Tabs, Tooltip, Typography, Button } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import MyLocationOutlinedIcon from '@mui/icons-material/MyLocationOutlined';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import VideocamOutlinedIcon from '@mui/icons-material/VideocamOutlined';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import DvrOutlinedIcon from '@mui/icons-material/DvrOutlined';
import AltRouteOutlinedIcon from '@mui/icons-material/AltRouteOutlined';
import { makeDraggable } from '../draggablePanel.js';
import { getCameraStreamUrl } from '../cctvCameras.js';
import { incidentVisual, incidentSeverity } from './incidentTypes.js';
import { IncidentTypeBadge } from './IncidentTypeIcon.jsx';
import { camerasNear, carriagewayAt, carriagewayLabel, distanceLabel, loadCorridorContext, segmentSpanLabel } from './incidentContext.js';
import { RelatedRecords, relatedRecordCount, useRelatedGroups } from './RelatedRecords.jsx';
import {
  isLiveEventAssetType, liveEventDetailSections, liveEventFacts, liveEventHeadline, liveEventImpactRows,
  liveEventNarrative, liveEventReportedAt, liveEventSeverity, liveEventSnapshots, liveEventVisual,
  liveEventWeatherLine,
} from './liveEventPresentation.js';
import { LiveEventBadge } from './LiveEventIcon.jsx';
import { detailFacts, impactRows, incidentFacts, incidentHeadline, incidentNarrative, reportedAt, RECOMMENDED_STEPS } from './incidentNarrative.js';

/** Wider than the generic panel: this one carries a camera image and a tab strip, not a field list. */
export const INCIDENT_DETAILS_WIDTH = 390;
/** The camera panel's own cadence, so two snapshots of the same corridor never disagree by age. */
const SNAPSHOT_INTERVAL_MS = 6000;

const TONE_COLOR = { danger: 'error.main', warning: 'warning.main', muted: 'text.secondary' };
const STEP_ICONS = { analysis: InsightsOutlinedIcon, sign: DvrOutlinedIcon, route: AltRouteOutlinedIcon };

/**
 * The corridor geometry, once, shared by every incident the operator clicks. Loading is per page,
 * not per selection — the same two GeoJSON files answer every incident.
 */
function useCorridorContext() {
  const [context, setContext] = useState(null);
  useEffect(() => {
    let live = true;
    void loadCorridorContext().then(loaded => { if (live) setContext(loaded); });
    return () => { live = false; };
  }, []);
  return context;
}

/** The live JPEG from one camera, re-fetched on the camera panel's cadence. */
function CameraSnapshot({ camera, height = 176, badge = true }) {
  const url = camera ? getCameraStreamUrl({ divas_chan_id: camera.divasChannelId }) : null;
  const [tick, setTick] = useState(() => Date.now());
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    setTick(Date.now());
    if (!url) return undefined;
    const timer = setInterval(() => setTick(Date.now()), SNAPSHOT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [url]);

  const frame = {
    // `flex: none` is load-bearing: the panel is a scrolling flex column, and a flex child with a
    // height is still shrunk to fit — which collapsed the snapshot to nothing while leaving its
    // overlay chips behind.
    position: 'relative', height, minHeight: height, flex: 'none',
    borderRadius: 1.5, overflow: 'hidden',
    border: 1, borderColor: 'divider', bgcolor: 'action.hover',
    display: 'grid', placeItems: 'center',
  };
  // No camera near enough to show: the panel simply has no live view, and an empty grey box saying
  // so takes a third of the panel to tell an operator nothing they can act on. The absence is its
  // own answer — the Cameras tab already reports how many are in range.
  if (!camera) return null;
  // A camera we DID offer and cannot draw is worth a line, because the operator is waiting on it.
  if (!url || failed) {
    return (
      <Box sx={frame}>
        <Stack spacing={0.5} sx={{ alignItems: 'center', color: 'text.secondary', px: 2, textAlign: 'center' }}>
          <VideocamOutlinedIcon fontSize="small" />
          <Typography variant="caption">
            {url ? `${camera.label} did not return a frame` : `${camera.label} has no public snapshot feed`}
          </Typography>
        </Stack>
      </Box>
    );
  }
  return (
    <Box sx={frame}>
      <Box
        component="img"
        src={`${url}?t=${tick}`}
        alt={`Live snapshot from ${camera.label}`}
        onError={() => setFailed(true)}
        sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
      {badge && (
        <Stack direction="row" spacing={0.5} sx={{ position: 'absolute', left: 8, bottom: 8, alignItems: 'center' }}>
          <Chip
            size="small"
            label={`Live · Cam ${camera.id}`}
            sx={{ bgcolor: 'rgba(11,23,41,0.78)', color: '#fff', border: '1px solid rgba(255,255,255,0.28)' }}
          />
          {distanceLabel(camera.metres) && (
            <Chip
              size="small"
              label={distanceLabel(camera.metres)}
              sx={{ bgcolor: 'rgba(11,23,41,0.78)', color: '#fff', border: '1px solid rgba(255,255,255,0.28)' }}
            />
          )}
        </Stack>
      )}
    </Box>
  );
}

/**
 * The camera photographs DataConnect stored for a live event — when it was first seen, and when it
 * was cleared.
 *
 * Different from the live snapshot above them, and kept: that one is the corridor NOW, these are
 * what the corridor looked like at the moment the event happened, which is the evidence an operator
 * writing it up afterwards actually needs.
 */
function StoredSnapshots({ event }) {
  const shots = liveEventSnapshots(event);
  if (!shots.length) return null;
  return (
    <Stack spacing={1}>
      {shots.map(shot => (
        <Box key={shot.url} sx={{ borderRadius: 1.5, border: 1, borderColor: 'divider', overflow: 'hidden', flex: 'none' }}>
          <Box
            component="a"
            href={shot.url}
            target="_blank"
            rel="noopener noreferrer"
            sx={{ display: 'block' }}
          >
            <Box component="img" src={shot.url} alt={`Camera snapshot ${shot.label.toLowerCase()}`} loading="lazy"
              sx={{ display: 'block', width: '100%' }} />
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1, py: 0.75 }}>
            {[shot.label, shot.cameraId ? `camera ${shot.cameraId}` : null, shot.takenAt].filter(Boolean).join(' · ')}
          </Typography>
        </Box>
      ))}
    </Stack>
  );
}

/** Several labelled groups of rows — what a live event's own fields and our matches look like. */
function FactSections({ sections }) {
  return (
    <Stack spacing={1.5}>
      {sections.map((section, index) => (
        <Box key={section.heading ?? `section-${index}`}>
          {section.heading && (
            <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{section.heading}</Typography>
          )}
          <FactGrid rows={section.rows} />
          {section.note && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
              {section.note}
            </Typography>
          )}
        </Box>
      ))}
    </Stack>
  );
}

/** The shared two-column definition grid, so the tabs read like the other panels on this map. */
function FactGrid({ rows }) {
  if (!rows.length) return <Typography variant="body2" color="text.secondary">This record carries no further details.</Typography>;
  return (
    <Box component="dl" sx={{ display: 'grid', gridTemplateColumns: '108px 1fr', gap: 1.25, m: 0, fontSize: 12, lineHeight: 1.5 }}>
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <Box component="dt" sx={{ color: 'text.secondary' }}>{label}</Box>
          <Box component="dd" sx={{ m: 0, overflowWrap: 'anywhere' }}>{value}</Box>
        </Fragment>
      ))}
    </Box>
  );
}

export function IncidentDetailsPanel({
  // The same top edge as the generic panel: below the app header and the workspace's KPI strip,
  // which this must not cover. The panel scrolls rather than growing past it.
  asset, inspecting, onClose, onInspect, onReturn, onViewCamera,
  lookupRecords = null, onOpenRecord = null, onHighlightCameras = null,
  top = 220, bottom = 16, right = 16,
}) {
  const panelRef = useRef(null);
  const headingRef = useRef(null);
  const [tab, setTab] = useState(0);
  const context = useCorridorContext();

  // Same floating behaviour as every other details panel on this map: the heading is the handle.
  useEffect(() => {
    if (!panelRef.current || !headingRef.current) return undefined;
    const drag = makeDraggable(panelRef.current, headingRef.current);
    return () => drag.destroy();
  }, [Boolean(asset)]);

  const record = asset?.source ?? null;
  const coordinates = asset?.coordinates ?? null;
  // Re-resolved only when the incident or the loaded geometry changes — not on every tab switch.
  const place = useMemo(
    () => (context && coordinates ? carriagewayAt(coordinates.longitude, coordinates.latitude, context.lines) : null),
    [context, coordinates],
  );
  // Only the cameras that can actually show a frame: a row reading "no public snapshot feed" is a
  // row an operator cannot use, and counting it in the tab's badge overstates what they can see.
  const cameras = useMemo(
    () => (context && coordinates
      ? camerasNear(coordinates.longitude, coordinates.latitude, context.cameras, { feedOnly: true })
      : []),
    [context, coordinates],
  );
  const leadCamera = cameras[0] ?? null;
  // Two kinds of record land in this panel: a maintenance incident from the register, and an FL511
  // live event from Live Ops. They are read the same way — what is it, how bad, where, what does it
  // do to the road — so they share the panel and differ only in where each line comes from. The
  // asset type decides, not the record's shape: both spell their own kind `type: 'INCIDENT'`.
  const liveEvent = isLiveEventAssetType(asset?.assetType);
  const facts = useMemo(
    () => (record ? (liveEvent ? liveEventFacts(record) : incidentFacts(record)) : null),
    [record, liveEvent],
  );
  // The crash is one class's record of an event the other four also wrote about — the ticket raised
  // for the guardrail it took out, the crew sent, the work order, the inspection that closed it.
  // A live event has no such history: it IS the present, so it is offered no Related tab.
  const related = useRelatedGroups(liveEvent ? null : record, lookupRecords);
  const relatedTotal = relatedRecordCount(related);
  const openRelated = onOpenRecord ? reference => { void onOpenRecord(reference.assetType, reference.id); } : null;

  // Selecting a different incident should not leave the panel on a tab about the previous one.
  useEffect(() => { setTab(0); }, [asset?.id]);

  // While the Cameras tab is open, its cameras are marked on the corridor — a list of four names
  // does not say which side of the crash they are on. They come off the map when the tab, the panel
  // or the incident changes, so the scene never keeps a camera the list is no longer offering.
  useEffect(() => {
    if (!onHighlightCameras) return undefined;
    onHighlightCameras(tab === 2 ? cameras : null);
    return () => onHighlightCameras(null);
  }, [onHighlightCameras, tab, cameras]);

  if (!asset || !record) return null;
  const visual = liveEvent ? liveEventVisual(record) : incidentVisual(facts.type);
  const severity = liveEvent ? liveEventSeverity(record) : incidentSeverity(record);
  const headline = liveEvent ? liveEventHeadline(facts) : incidentHeadline(facts);
  const narrative = liveEvent ? liveEventNarrative(record, place) : incidentNarrative(record, place);
  const reported = liveEvent ? liveEventReportedAt(facts) : reportedAt(facts);
  const showRelated = Boolean(lookupRecords) && !liveEvent;
  const weatherLine = liveEvent ? liveEventWeatherLine(record) : null;
  const subtitle = liveEvent
    ? [asset.id, facts.carriageway ?? (place?.resolved ? carriagewayLabel(place) : null), facts.section ?? facts.roadway]
    : [asset.id, place?.resolved ? carriagewayLabel(place) : null, facts.segment];

  return (
    <Paper
      ref={panelRef}
      elevation={4}
      sx={{
        position: 'absolute', right, top, width: INCIDENT_DETAILS_WIDTH, zIndex: 60,
        maxHeight: `calc(100% - ${top + bottom}px)`,
        // No padding and no scrolling on the Paper itself: the heading is pinned and the BODY
        // scrolls under it, so Close and the incident's name stay on screen however long the
        // Related tab gets. Padding lives on the two sections instead.
        p: 0, borderRadius: 2, overflow: 'hidden',
        display: 'flex', flexDirection: 'column', pointerEvents: 'auto',
        // The one place the family colour is structural rather than decorative: the panel's left
        // edge says which kind of incident is open before a word is read.
        borderLeft: `4px solid ${visual.color}`,
      }}
      role="complementary"
      aria-label={`${facts.type ?? (liveEvent ? 'Live event' : 'Incident')} details`}
    >
      <Stack
        ref={headingRef}
        direction="row"
        spacing={1.25}
        sx={{
          position: 'relative', flex: 'none', alignItems: 'flex-start',
          px: 2, pt: 2, pb: 1.5, borderBottom: 1, borderColor: 'divider',
          // Room for the close button, which sits in the panel's own corner rather than inline —
          // so the title can be any length without pushing it out of reach.
          pr: 6,
        }}
      >
        {liveEvent ? <LiveEventBadge event={record} /> : <IncidentTypeBadge incidentType={facts.type} />}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
            <Typography component="h2" sx={{ flex: 1, minWidth: 0, fontSize: 16, fontWeight: 600, lineHeight: 1.25 }}>
              {facts.type ?? 'Incident'}
            </Typography>
            <Chip
              size="small"
              label={severity.level}
              sx={{ flex: 'none', color: TONE_COLOR[severity.tone], borderColor: TONE_COLOR[severity.tone] }}
              variant="outlined"
            />
          </Stack>
          <Typography variant="caption" color="text.secondary" component="div">
            {subtitle.filter(Boolean).join(' · ')}
          </Typography>
          {reported && (
            <Typography variant="caption" color="text.secondary" component="div">{`Reported ${reported}`}</Typography>
          )}
          {/* The weather captured when the event was first seen — FL511 does not publish it. */}
          {weatherLine && (
            <Typography variant="caption" color="text.secondary" component="div">{weatherLine}</Typography>
          )}
        </Box>
        <Tooltip title="Close incident details">
          {/* The panel's top-right corner, pinned: a drag handle ignores clicks on a button, so
              this stays clickable while the heading still moves the panel. */}
          <IconButton onClick={onClose} aria-label="Close incident details"
            sx={{ position: 'absolute', top: 8, right: 8, width: 32, height: 32, borderRadius: 1, bgcolor: 'action.hover' }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {/* Everything below the heading scrolls. */}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <CameraSnapshot camera={leadCamera} />

      {liveEvent && <StoredSnapshots event={record} />}

      {headline.length > 0 && (
        <Stack direction="row" spacing={1}>
          {headline.map(card => (
            <Box key={card.label} sx={{ flex: 1, minWidth: 0, p: 1, borderRadius: 1.5, border: 1, borderColor: 'divider' }}>
              <Typography sx={{ fontSize: 18, fontWeight: 700, lineHeight: 1.1, color: TONE_COLOR[card.tone] }}>{card.value}</Typography>
              <Typography variant="caption" color="text.secondary" component="div" sx={{ lineHeight: 1.3 }}>{card.label}</Typography>
            </Box>
          ))}
        </Stack>
      )}

      <Tabs
        value={tab}
        onChange={(event, next) => setTab(next)}
        variant="fullWidth"
        sx={{ minHeight: 34, borderBottom: 1, borderColor: 'divider', '& .MuiTab-root': { minHeight: 34, fontSize: 12, py: 0, px: 0.5, minWidth: 0 } }}
      >
        <Tab label="Details" />
        <Tab label="Impact" />
        <Tab label={`Cameras (${cameras.length})`} />
        {showRelated ? <Tab label={`Related (${relatedTotal})`} /> : null}
      </Tabs>

      {tab === 0 && (liveEvent
        ? <FactSections sections={liveEventDetailSections(record)} />
        : <FactGrid rows={detailFacts(record, place)} />)}

      {tab === 1 && (
        <Stack spacing={1.25}>
          {narrative.map(sentence => (
            <Typography key={sentence} variant="body2" sx={{ lineHeight: 1.5 }}>{sentence}</Typography>
          ))}
          <FactGrid rows={liveEvent ? liveEventImpactRows(record, place) : impactRows(record, place)} />
          {!liveEvent && (
            <Typography variant="caption" color="text.secondary">
              Delay and queue length are not recorded for historical incidents, so none is shown.
            </Typography>
          )}
        </Stack>
      )}

      {tab === 2 && (
        <Stack spacing={1.25}>
          {cameras.length === 0 && (
            <Typography variant="body2" color="text.secondary">No corridor camera lies within range of this incident.</Typography>
          )}
          {cameras.map(camera => (
            <Box key={camera.id} sx={{ borderRadius: 1.5, border: 1, borderColor: 'divider', overflow: 'hidden' }}>
              <CameraSnapshot camera={camera} height={112} badge={false} />
              <Stack direction="row" spacing={1} sx={{ p: 1, alignItems: 'center' }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="subtitle2" noWrap>{`Cam ${camera.id}`}</Typography>
                  <Typography variant="caption" color="text.secondary" noWrap component="div">
                    {[camera.description, camera.direction, distanceLabel(camera.metres)].filter(Boolean).join(' · ')}
                  </Typography>
                </Box>
                {onViewCamera && (
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => onViewCamera({ coordinates: { longitude: camera.longitude, latitude: camera.latitude }, name: `Cam ${camera.id}` })}
                  >
                    Street View
                  </Button>
                )}
              </Stack>
            </Box>
          ))}
        </Stack>
      )}

      {showRelated && tab === 3 && (
        <RelatedRecords
          groups={related}
          onOpen={openRelated}
          emptyMessage="No ticket, task, work order or inspection names this incident or stands on its asset."
        />
      )}

      <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.75 }}>Recommended next steps</Typography>
        <Stack spacing={0.75}>
          {RECOMMENDED_STEPS.map(step => {
            const Icon = STEP_ICONS[step.icon] ?? InsightsOutlinedIcon;
            return (
              <Stack
                key={step.id}
                direction="row"
                spacing={1}
                sx={{ alignItems: 'center', p: 1, borderRadius: 1.5, border: 1, borderColor: 'divider', color: 'text.secondary' }}
              >
                <Icon fontSize="small" />
                <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>{step.label}</Typography>
                <ChevronRightIcon fontSize="small" />
              </Stack>
            );
          })}
        </Stack>
        {/* Said out loud rather than implied by a greyed-out row: these do not answer anything yet. */}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          Placeholders — the Twin will answer these once the impact model is wired in.
        </Typography>
      </Box>

      <Stack spacing={1}>
        <Button variant="contained" startIcon={<MyLocationOutlinedIcon />} onClick={() => onInspect(asset)}
          disabled={!asset.coordinates} aria-label={`View ${asset.id} on map`}>
          View on map
        </Button>
        {inspecting && (
          <Button variant="text" startIcon={<ArrowBackOutlinedIcon />} onClick={onReturn} aria-label="Return to the previous view">
            Back to corridor view
          </Button>
        )}
      </Stack>
      </Box>
    </Paper>
  );
}

/** What the heading's second line says, exported so the card and the panel cannot disagree. */
export const incidentPlaceLabel = place => (place?.resolved ? carriagewayLabel(place) : null);
export { segmentSpanLabel };
