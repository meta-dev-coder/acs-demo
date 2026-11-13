/**
 * The details panel for one ACS demo case.
 *
 * Same family as the other panels on this map — floating Paper, draggable heading, Close pinned in
 * the corner, View on map at the bottom — so a demo case behaves like any other selected record.
 * What it adds is the lifecycle: the four stage states the validation engine derived, what holds
 * the case up, and the one action that would move it on.
 *
 * It opens with a DEMO banner and never without one. Everything in a case except its location is
 * invented, and a record this complete is the most convincing thing on the screen: if the banner
 * were conditional, the condition would eventually be wrong.
 */
import { useEffect, useRef, useState } from 'react';
import { Box, Button, Chip, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import MyLocationOutlinedIcon from '@mui/icons-material/MyLocationOutlined';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import { makeDraggable } from '../draggablePanel.js';
import { positionLabel } from './assetTypes.js';
import { AcsCaseDialog } from './AcsCaseDialog.jsx';
import { STAGE_LABELS } from '../qcqa/stageValidation.js';
import { STAGE_ORDER, STAGE_PRESENTATION } from '../acs/acsDemoCases.js';

export const DEMO_CASE_DETAILS_WIDTH = 332;

const TONE_COLOR = { ok: 'success.main', warn: 'warning.main', bad: 'error.main',
  info: 'info.main', muted: 'text.secondary' };

/**
 * A demo case's timestamps, in the corridor's own timezone.
 *
 * Every time in the case file is written with a -04:00 offset, because that is what a Broward
 * County record would carry. Rendered in the reader's zone they came out hours adrift from the
 * narrative, which made a night shift read as an afternoon one.
 */
const dateTime = value => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value)
    : `${parsed.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET`;
};

/** One label-over-value row, or nothing at all when there is no value to show. */
function Row({ label, value }) {
  if (value == null || value === '') return null;
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" component="div"
        sx={{ textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 9.5 }}>
        {label}
      </Typography>
      <Typography sx={{ fontSize: 12.5, fontWeight: 600, overflowWrap: 'anywhere' }}>{value}</Typography>
    </Box>
  );
}

/** The four stages, in order, each with the state the engine derived for it. */
export function StageTrack({ evaluation, dense = false }) {
  return (
    <Stack spacing={dense ? 0.4 : 0.6}>
      {STAGE_ORDER.map(key => {
        const stage = evaluation.stages[key];
        const tone = STAGE_PRESENTATION[stage.status] ?? STAGE_PRESENTATION.PENDING;
        return (
          <Stack key={key} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Box sx={{ width: 6, height: 6, borderRadius: '50%', flex: 'none',
              bgcolor: TONE_COLOR[tone.tone] ?? 'text.secondary' }} aria-hidden />
            <Typography sx={{ fontSize: 12, flex: 1, minWidth: 0 }}>{STAGE_LABELS[key]}</Typography>
            <Typography sx={{ fontSize: 11.5, fontWeight: 700, color: TONE_COLOR[tone.tone] ?? 'text.secondary' }}>
              {tone.label}
            </Typography>
          </Stack>
        );
      })}
    </Stack>
  );
}

export function AcsDemoCasePanel({
  asset, inspecting, onClose, onInspect, onReturn,
  top = 220, bottom = 16, right = 16,
}) {
  const panelRef = useRef(null);
  const headingRef = useRef(null);
  const [caseOpen, setCaseOpen] = useState(false);

  useEffect(() => {
    if (!panelRef.current || !headingRef.current) return undefined;
    const drag = makeDraggable(panelRef.current, headingRef.current);
    return () => drag.destroy();
  }, [Boolean(asset)]);

  // Moving to another case must not leave the previous one's dialog open over it.
  useEffect(() => { setCaseOpen(false); }, [asset?.id]);

  const record = asset?.source ?? null;
  const demoCase = record?.demoCase ?? null;
  const evaluation = record?.evaluation ?? null;
  if (!asset || !demoCase || !evaluation) return null;

  const overall = evaluation.presentation;
  const location = evaluation.location;
  const outlook = record.outlook ?? null;

  return (
    <Paper
      ref={panelRef}
      elevation={4}
      sx={{
        position: 'absolute', right, top, width: DEMO_CASE_DETAILS_WIDTH, zIndex: 60,
        maxHeight: `calc(100% - ${top + bottom}px)`,
        p: 0, borderRadius: 2, overflow: 'hidden',
        display: 'flex', flexDirection: 'column', pointerEvents: 'auto',
      }}
      role="complementary"
      aria-label={`Demo case ${demoCase.demoCaseId}`}
    >
      <Stack
        ref={headingRef}
        direction="row"
        spacing={1}
        sx={{ position: 'relative', flex: 'none', alignItems: 'flex-start',
          px: 2, pt: 1.75, pb: 1.25, pr: 6.5, borderBottom: 1, borderColor: 'divider' }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.25 }}>
            <Typography variant="caption" color="text.secondary">Demo case</Typography>
            <Chip size="small" color="secondary" variant="outlined" icon={<ScienceOutlinedIcon sx={{ fontSize: 13 }} />}
              label={demoCase.demoLabel} sx={{ height: 18, fontSize: 9.5, fontWeight: 700 }} />
          </Stack>
          <Typography component="h2" sx={{ fontSize: 17, fontWeight: 700, lineHeight: 1.2 }}>
            {demoCase.demoCaseId}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 11.5 }}>
            {demoCase.incident.incidentType} · {demoCase.asset.assetName}
          </Typography>
        </Box>
        <Tooltip title="Close demo case">
          <IconButton onClick={onClose} aria-label="Close demo case"
            sx={{ position: 'absolute', top: 10, right: 10, width: 36, height: 36, borderRadius: 1, bgcolor: 'action.hover' }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Chip size="small" label={overall.label} variant="outlined"
            sx={{ height: 22, fontSize: 11.5, fontWeight: 700,
              color: TONE_COLOR[overall.tone], borderColor: TONE_COLOR[overall.tone] }} />
          <Typography variant="caption" color="text.secondary">
            Stage: {STAGE_LABELS[demoCase.workflow.currentStage] ?? demoCase.workflow.currentStage}
          </Typography>
        </Stack>

        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 1.25 }}>
          <Typography sx={{ fontSize: 11.5, fontWeight: 700, mb: 0.75 }}>Lifecycle</Typography>
          <StageTrack evaluation={evaluation} />
        </Box>

        {outlook && (
          <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 1.25 }}>
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 0.75 }}>
              <Typography sx={{ fontSize: 11.5, fontWeight: 700 }}>Evidence</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
                Open the case for the search
              </Typography>
            </Stack>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 0.75 }}>
              {[
                ['Missing', outlook.missing, 'warning.main'],
                ['Recoverable', outlook.recoverable, 'success.main'],
                ['Unresolved', outlook.unresolved, 'error.main'],
                ['Related', outlook.enrichment, 'info.main'],
              ].map(([label, value, tone]) => (
                <Box key={label} sx={{ p: 0.75, borderRadius: 1, border: 1, borderColor: 'divider' }}>
                  <Typography sx={{ fontSize: 15, fontWeight: 700, lineHeight: 1.1,
                    color: value ? tone : 'text.disabled' }}>{value}</Typography>
                  <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 9.5 }}>
                    {label}
                  </Typography>
                </Box>
              ))}
            </Box>
            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', mt: 0.75 }}>
              <Box sx={{ width: 6, height: 6, borderRadius: '50%', flex: 'none',
                bgcolor: outlook.contextAvailable ? 'success.main' : 'text.disabled' }} aria-hidden />
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10.5 }}>
                {outlook.contextAvailable
                  ? 'Incident-time weather and traffic context available'
                  : 'No located incident, so no incident-time context'}
              </Typography>
            </Stack>
          </Box>
        )}

        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 1.25 }}>
          <Row label="Incident date" value={dateTime(demoCase.incident.reportedAt)} />
          <Row label="Asset type" value={demoCase.asset.assetType} />
          <Row label="Roadway" value={location.roadway} />
          <Row label="Direction" value={location.direction ?? 'Not recorded on the source incident'} />
          <Row label="Corridor position" value={positionLabel(asset) ?? 'No location'} />
          <Row label="Segment" value={location.segmentId} />
          <Row label="Source incident" value={location.sourceIncidentId ?? 'None available'} />
          <Row label="Checklist" value={evaluation.checklist.declared} />
        </Box>

        <Box sx={{ border: 1, borderColor: 'warning.main', borderRadius: 1.5, p: 1.25,
          bgcolor: theme => `${theme.palette.warning.main}0f` }}>
          <Typography sx={{ fontSize: 11.5, fontWeight: 700, mb: 0.5 }}>Next required action</Typography>
          <Typography sx={{ fontSize: 12, lineHeight: 1.5 }}>{evaluation.nextAction.text}</Typography>
          {evaluation.nextAction.role && (
            <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
              {evaluation.nextAction.role.replace(/_/g, ' ').toLowerCase()}
              {evaluation.nextAction.team ? ` · ${evaluation.nextAction.team}` : ''}
            </Typography>
          )}
        </Box>

        <Stack spacing={1}>
          <Button variant="contained" color="primary" endIcon={<ChevronRightIcon />}
            onClick={() => setCaseOpen(true)}
            aria-label={`Open ACS case ${demoCase.demoCaseId}`}>
            Open ACS Case
          </Button>
          <Button variant="outlined" startIcon={<MyLocationOutlinedIcon />}
            onClick={() => onInspect(asset)} disabled={!asset.coordinates}
            aria-label={`View ${demoCase.demoCaseId} on map`}>
            View on map
          </Button>
          {inspecting && (
            <Button variant="text" startIcon={<ArrowBackOutlinedIcon />} onClick={onReturn}
              aria-label="Return to the previous view">
              Back to corridor view
            </Button>
          )}
        </Stack>
      </Box>

      <AcsCaseDialog open={caseOpen} onClose={() => setCaseOpen(false)} demoCase={record} />
    </Paper>
  );
}
