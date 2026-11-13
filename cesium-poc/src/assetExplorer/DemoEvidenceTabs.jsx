/**
 * The Evidence Recovery and Incident Context tabs of the ACS case popup.
 *
 * Both are views over something else's output. The recovery tab renders what the Case Enrichment
 * Orchestrator found and lets a reviewer accept or reject each candidate; it decides nothing
 * itself, and the Apply button is the only thing that changes a case's validation. The context tab
 * renders observations that each carry their own source, timestamp, spatial match, units and
 * quality, and draws the synthetic ones differently from the measured ones.
 *
 * The rule both obey: a value whose provenance cannot be shown is not drawn.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box, Button, Chip, CircularProgress, Divider, Radio, Stack, Tooltip, Typography,
} from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import CloudOutlinedIcon from '@mui/icons-material/CloudOutlined';
import TrafficOutlinedIcon from '@mui/icons-material/TrafficOutlined';
import { MATCH_TIER, SEARCH_STATUS, SYSTEM_LABELS } from '../acs/evidence/orchestrator.js';
import { DATA_QUALITY, OBSERVATION_SOURCE } from '../acs/incidentContext.js';
import { STAGE_LABELS } from '../qcqa/stageValidation.js';

const TIER_TONE = Object.freeze({
  [MATCH_TIER.EXACT]: { color: 'success.main', label: 'Exact match' },
  [MATCH_TIER.PROBABLE]: { color: 'info.main', label: 'Probable match' },
  [MATCH_TIER.POSSIBLE]: { color: 'warning.main', label: 'Possible match' },
  [MATCH_TIER.WEAK]: { color: 'text.secondary', label: 'Weak match' },
});

const STATUS_TONE = Object.freeze({
  [SEARCH_STATUS.OK]: { color: 'success.main', label: 'Answered' },
  [SEARCH_STATUS.NO_MATCH]: { color: 'text.secondary', label: 'Nothing found' },
  [SEARCH_STATUS.UNAVAILABLE]: { color: 'error.main', label: 'No response' },
});

const clock = value => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value)
    : `${parsed.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET`;
};

function Panel({ title, action = null, children }) {
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 1.5 }}>
      {(title || action) && (
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 700 }}>{title}</Typography>
          {action}
        </Stack>
      )}
      {children}
    </Box>
  );
}

function Pill({ tone, children }) {
  return (
    <Box component="span" sx={{
      px: 0.9, py: 0.2, borderRadius: 1, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap',
      alignSelf: 'flex-start', flex: 'none', lineHeight: 1.5, color: tone, border: 1, borderColor: tone,
    }}>{children}</Box>
  );
}

function Tile({ label, value, tone = 'text.primary' }) {
  return (
    <Box sx={{ p: 1, borderRadius: 1, border: 1, borderColor: 'divider', minWidth: 0 }}>
      <Typography sx={{ fontSize: 18, fontWeight: 700, lineHeight: 1.1, color: value ? tone : 'text.disabled' }}>
        {value}
      </Typography>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ lineHeight: 1.3 }}>
        {label}
      </Typography>
    </Box>
  );
}

/** The badge a synthetic record carries wherever it appears. Never optional. */
function SyntheticMark({ origin, synthetic }) {
  if (!synthetic && origin !== 'SYNTHETIC') return null;
  return (
    <Tooltip title="This system has no endpoint or credentials in this deployment. The response is a deterministic stand-in, not an API result.">
      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.3,
        px: 0.6, py: 0.15, borderRadius: 0.75, fontSize: 9.5, fontWeight: 800, letterSpacing: 0.04,
        color: 'secondary.main', border: 1, borderColor: 'secondary.main' }}>
        <ScienceOutlinedIcon sx={{ fontSize: 11 }} /> SYNTHETIC
      </Box>
    </Tooltip>
  );
}

/* --- Evidence Recovery -------------------------------------------------------------------- */

/** One candidate record, with why the engine proposed it and the control to accept it. */
function Candidate({ candidate, chosen, onChoose, disabled }) {
  const tone = TIER_TONE[candidate.tier] ?? TIER_TONE[MATCH_TIER.WEAK];
  return (
    <Box sx={{
      p: 1, borderRadius: 1, border: 1, mb: 0.75,
      borderColor: chosen ? 'primary.main' : 'divider',
      bgcolor: chosen ? 'action.selected' : 'transparent',
    }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
        <Radio size="small" checked={chosen} disabled={disabled}
          onChange={() => onChoose(candidate.recordId)}
          inputProps={{ 'aria-label': `Accept ${candidate.recordId}` }}
          sx={{ p: 0.25, mt: 0.1 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.4 }}>
            <Typography sx={{ fontSize: 12.5, fontWeight: 700 }}>{candidate.recordId}</Typography>
            <Pill tone={tone.color}>{tone.label} · {candidate.confidence}%</Pill>
            <Typography variant="caption" color="text.secondary">
              {SYSTEM_LABELS[candidate.system] ?? candidate.system} · {candidate.recordType}
            </Typography>
            <SyntheticMark origin={candidate.origin} synthetic={candidate.synthetic} />
          </Stack>
          <Typography sx={{ fontSize: 12, lineHeight: 1.5 }}>{candidate.summary}</Typography>
          {candidate.value && (
            <Typography sx={{ fontSize: 11.5, lineHeight: 1.5, color: 'text.secondary' }}>
              Value: {candidate.value}
            </Typography>
          )}
          <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 10.5, lineHeight: 1.45, mt: 0.3 }}>
            {candidate.explanation}
            {candidate.capturedAt ? ` Captured ${clock(candidate.capturedAt)}.` : ''}
          </Typography>
          {candidate.matchedRules.length > 0 && (
            <Stack direction="row" spacing={0.5} sx={{ mt: 0.5, flexWrap: 'wrap', rowGap: 0.4 }}>
              {candidate.matchedRules.map(rule => (
                <Chip key={rule.id} size="small" variant="outlined"
                  label={`${rule.label} +${rule.weight}`}
                  sx={{ height: 17, fontSize: 9.5,
                    borderColor: rule.identifier ? 'success.main' : 'divider',
                    color: rule.identifier ? 'success.main' : 'text.secondary' }} />
              ))}
            </Stack>
          )}
          {candidate.warnings.map(warning => (
            <Stack key={warning.kind} direction="row" spacing={0.5} sx={{ alignItems: 'flex-start', mt: 0.5 }}>
              <WarningAmberOutlinedIcon sx={{ fontSize: 13, color: 'warning.main', mt: '2px' }} />
              <Typography sx={{ fontSize: 10.5, lineHeight: 1.45, color: 'warning.main' }}>
                {warning.text}
              </Typography>
            </Stack>
          ))}
        </Box>
      </Stack>
    </Box>
  );
}

/** One gap: what is missing, what was found for it, and what the reviewer decided. */
function Gap({ gap, decision, onDecide }) {
  return (
    <Panel
      title={gap.label}
      action={<Typography variant="caption" color="text.secondary">
        {STAGE_LABELS[gap.stage] ?? gap.stage} · {gap.evidenceType}
      </Typography>}>
      {gap.humanOnly ? (
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'flex-start' }}>
          <BlockOutlinedIcon sx={{ fontSize: 15, color: 'error.main', mt: '2px' }} />
          <Box>
            <Typography sx={{ fontSize: 12, fontWeight: 700, color: 'error.main' }}>
              Cannot be recovered from any system
            </Typography>
            <Typography sx={{ fontSize: 11.5, lineHeight: 1.5 }}>{gap.humanOnly.reason}</Typography>
          </Box>
        </Stack>
      ) : !gap.candidates.length ? (
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'flex-start' }}>
          <WarningAmberOutlinedIcon sx={{ fontSize: 15, color: 'warning.main', mt: '2px' }} />
          <Typography sx={{ fontSize: 11.5, lineHeight: 1.5 }}>
            No system returned a record for this. The gap stands, and nothing has been substituted
            for it.
          </Typography>
        </Stack>
      ) : (
        <>
          {gap.requiresReview && (
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'flex-start', mb: 0.75 }}>
              <WarningAmberOutlinedIcon sx={{ fontSize: 14, color: 'warning.main', mt: '2px' }} />
              <Typography sx={{ fontSize: 11, lineHeight: 1.45, color: 'warning.main' }}>
                Needs your confirmation: {gap.reviewReason}
              </Typography>
            </Stack>
          )}
          {gap.candidates.map(candidate => (
            <Candidate key={candidate.recordId} candidate={candidate}
              chosen={decision === candidate.recordId}
              onChoose={recordId => onDecide(gap.fieldId, recordId)} disabled={false} />
          ))}
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 0.5 }}>
            <Button size="small" variant="text" onClick={() => onDecide(gap.fieldId, '')}
              sx={{ fontSize: 11, textTransform: 'none' }}>
              Reject all for this field
            </Button>
            {decision === '' && (
              <Typography variant="caption" color="text.secondary">Rejected — the gap stands.</Typography>
            )}
          </Stack>
        </>
      )}
    </Panel>
  );
}

/**
 * @param {{recovery: object|null, loading: boolean, decisions: object, onDecide: Function,
 *          onApply: Function, applied: object|null, outcome: string|null,
 *          packageOutcome: object|null, lineage: object[]}} props
 */
export function EvidenceRecoveryTab({ recovery, loading, decisions, onDecide, onApply, applied,
  outcome, packageOutcome }) {
  if (loading) {
    return (
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', py: 2 }}>
        <CircularProgress size={16} />
        <Typography variant="body2" color="text.secondary">Searching connected systems…</Typography>
      </Stack>
    );
  }
  if (!recovery) {
    return (
      <Panel title="Evidence recovery">
        <Typography sx={{ fontSize: 12, color: 'warning.main' }}>
          The recovery search could not be run for this case.
        </Typography>
      </Panel>
    );
  }
  const { summary } = recovery;
  const accepted = Object.values(decisions).filter(Boolean).length;

  return (
    <Stack spacing={1.5}>
      {outcome && (
        <Box sx={{ border: 1, borderColor: 'info.main', borderRadius: 1.5, p: 1.25,
          bgcolor: theme => `${theme.palette.info.main}12` }}>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.4 }}>
            <InfoOutlinedIcon sx={{ fontSize: 15, color: 'info.main' }} />
            <Typography sx={{ fontSize: 12.5, fontWeight: 700, color: 'info.main' }}>
              What this case demonstrates
            </Typography>
          </Stack>
          <Typography sx={{ fontSize: 12, lineHeight: 1.55 }}>{outcome}</Typography>
        </Box>
      )}

      <Panel title="Missing evidence">
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))', gap: 0.75 }}>
          <Tile label="Missing" value={summary.missing} tone="warning.main" />
          <Tile label="Recoverable" value={summary.recoverable} tone="success.main" />
          <Tile label="Needs review" value={summary.needsReview} tone="info.main" />
          <Tile label="Person required" value={summary.humanOnly} tone="error.main" />
          <Tile label="Unresolved" value={summary.unresolved} tone="error.main" />
          <Tile label="Context records" value={summary.enrichment} tone="text.primary" />
        </Box>
      </Panel>

      <Panel title={`Source search (${summary.systemsQueried} systems)`}>
        <Stack spacing={0}>
          {recovery.searches.map(search => {
            const tone = STATUS_TONE[search.status] ?? STATUS_TONE[SEARCH_STATUS.NO_MATCH];
            return (
              <Stack key={search.system} direction="row" spacing={1}
                sx={{ alignItems: 'flex-start', py: 0.6, borderBottom: 1, borderColor: 'divider',
                  '&:last-of-type': { borderBottom: 0 } }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.3 }}>
                    <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{search.label}</Typography>
                    <SyntheticMark origin={search.origin} synthetic={search.origin === 'SYNTHETIC'} />
                  </Stack>
                  <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 10.5, lineHeight: 1.45 }}>
                    {search.error ?? `${search.count} record${search.count === 1 ? '' : 's'} returned`}
                  </Typography>
                </Box>
                <Pill tone={tone.color}>{tone.label}</Pill>
              </Stack>
            );
          })}
        </Stack>
      </Panel>

      {recovery.gaps.map(gap => (
        <Gap key={gap.fieldId} gap={gap} decision={decisions[gap.fieldId]} onDecide={onDecide} />
      ))}

      {!recovery.gaps.length && (
        <Panel title="Missing evidence">
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
            <CheckCircleOutlineIcon sx={{ fontSize: 15, color: 'success.main' }} />
            <Typography sx={{ fontSize: 12 }}>
              Nothing is missing on this case, so there is nothing to recover.
            </Typography>
          </Stack>
        </Panel>
      )}

      {Boolean(recovery.enrichment.length) && (
        <Panel title={`Related records (${recovery.enrichment.length})`}>
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.75, lineHeight: 1.45 }}>
            Records that fill no gap but say something about this case. They are context, and
            attaching them is not offered.
          </Typography>
          <Stack spacing={0.75}>
            {recovery.enrichment.map(record => (
              <Box key={record.recordId} sx={{ p: 1, borderRadius: 1, border: 1, borderColor: 'divider' }}>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.3 }}>
                  <Typography sx={{ fontSize: 12.5, fontWeight: 700 }}>{record.recordId}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {SYSTEM_LABELS[record.system] ?? record.system} · {record.recordType}
                  </Typography>
                  <SyntheticMark origin={record.origin} synthetic={record.synthetic} />
                </Stack>
                <Typography sx={{ fontSize: 12, lineHeight: 1.5 }}>{record.summary}</Typography>
                {record.value && (
                  <Typography sx={{ fontSize: 11.5, lineHeight: 1.5, color: 'text.secondary' }}>{record.value}</Typography>
                )}
                {record.capturedAt && (
                  <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 10.5 }}>
                    {clock(record.capturedAt)}
                  </Typography>
                )}
              </Box>
            ))}
          </Stack>
        </Panel>
      )}

      {Boolean(recovery.lineage.length) && (
        <Panel title={`Evidence lineage (${recovery.lineage.length})`}>
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.75, lineHeight: 1.45 }}>
            Where every piece of evidence this case already holds came from. Nothing here was
            recovered — it was filed at the time.
          </Typography>
          <Stack spacing={0}>
            {recovery.lineage.map(entry => (
              <Box key={entry.recordId} sx={{ py: 0.6, borderBottom: 1, borderColor: 'divider',
                '&:last-of-type': { borderBottom: 0 } }}>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.3 }}>
                  <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{entry.label}</Typography>
                  <Pill tone="text.secondary">{SYSTEM_LABELS[entry.system] ?? entry.system}</Pill>
                  <Typography variant="caption" color="text.secondary">{entry.recordId}</Typography>
                </Stack>
                <Typography sx={{ fontSize: 11.5, lineHeight: 1.5 }}>{entry.note}</Typography>
                <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 10.5 }}>
                  Filed {clock(entry.filedAt)} by {entry.filedBy}
                </Typography>
              </Box>
            ))}
          </Stack>
        </Panel>
      )}

      {packageOutcome && (
        <Panel title="Claim package">
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
            <Pill tone="info.main">{packageOutcome.status.replace(/_/g, ' ')}</Pill>
          </Stack>
          <Typography sx={{ fontSize: 11.5, lineHeight: 1.55 }}>{packageOutcome.note}</Typography>
        </Panel>
      )}

      <Divider />

      <Panel title="Re-validation">
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.75 }}>
          <Button size="small" variant="contained" disabled={!accepted} onClick={onApply}>
            Attach {accepted || 'no'} accepted record{accepted === 1 ? '' : 's'} and re-validate
          </Button>
          <Typography variant="caption" color="text.secondary">
            Nothing is attached until you do this, and the original record is never overwritten.
          </Typography>
        </Stack>
        {applied && (
          <Box sx={{ mt: 1.25, p: 1.25, borderRadius: 1, border: 1,
            borderColor: applied.delta.overallChanged ? 'success.main' : 'divider' }}>
            <Typography sx={{ fontSize: 12.5, fontWeight: 700, mb: 0.4 }}>
              {applied.delta.overallChanged
                ? `Overall status moved from ${applied.delta.overallBefore} to ${applied.delta.overallAfter}.`
                : `Overall status is unchanged: ${applied.delta.overallAfter}.`}
            </Typography>
            {applied.delta.changes.length ? (
              <Stack spacing={0.3}>
                {applied.delta.changes.map(change => (
                  <Typography key={change.stage} sx={{ fontSize: 11.5 }}>
                    {STAGE_LABELS[change.stage] ?? change.stage}: {change.from} → {change.to}
                  </Typography>
                ))}
              </Stack>
            ) : (
              <Typography sx={{ fontSize: 11.5, lineHeight: 1.5, color: 'text.secondary' }}>
                The accepted records closed {Object.keys(applied.attachments).length} gap
                {Object.keys(applied.attachments).length === 1 ? '' : 's'}, but no stage changed
                state. What is still holding this case is not a missing document.
              </Typography>
            )}
          </Box>
        )}
      </Panel>
    </Stack>
  );
}

/* --- Incident Context --------------------------------------------------------------------- */

const QUALITY_TONE = Object.freeze({
  [DATA_QUALITY.MEASURED]: 'success.main',
  [DATA_QUALITY.MODELLED]: 'info.main',
  [DATA_QUALITY.DERIVED]: 'info.main',
  [DATA_QUALITY.SYNTHETIC]: 'secondary.main',
  [DATA_QUALITY.UNAVAILABLE]: 'text.disabled',
});

/** One observation, with its provenance beside it rather than in a footnote. */
function Observation({ entry }) {
  const tone = QUALITY_TONE[entry.quality] ?? 'text.secondary';
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', py: 0.6,
      borderBottom: 1, borderColor: 'divider', '&:last-of-type': { borderBottom: 0 } }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{entry.label}</Typography>
        <Typography sx={{ fontSize: 13, color: entry.value == null ? 'text.disabled' : 'text.primary' }}>
          {entry.value == null ? '— no reading —'
            : `${entry.value}${entry.unit ? ` ${entry.unit}` : ''}`}
        </Typography>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 10.5, lineHeight: 1.45 }}>
          {entry.note}
        </Typography>
      </Box>
      <Stack spacing={0.3} sx={{ alignItems: 'flex-end', flex: 'none' }}>
        <Pill tone={tone}>{entry.quality}</Pill>
        {entry.observedAt && (
          <Typography variant="caption" color="text.secondary" sx={{ fontSize: 9.5 }}>
            {entry.spatialMatch}
          </Typography>
        )}
      </Stack>
    </Stack>
  );
}

export function IncidentContextTab({ context, loading }) {
  if (loading) {
    return (
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', py: 2 }}>
        <CircularProgress size={16} />
        <Typography variant="body2" color="text.secondary">
          Reading the conditions at the incident time…
        </Typography>
      </Stack>
    );
  }
  if (!context) {
    return (
      <Panel title="Incident context">
        <Typography sx={{ fontSize: 12, color: 'warning.main' }}>
          No context could be assembled for this case.
        </Typography>
      </Panel>
    );
  }
  const { weather, traffic } = context;

  return (
    <Stack spacing={1.5}>
      <Panel title="At the incident time">
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 1.25 }}>
          <Box>
            <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 10 }}>INCIDENT</Typography>
            <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{clock(context.incidentAt)}</Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 10 }}>WEATHER HOUR</Typography>
            <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>
              {context.incidentHourLabel ?? 'No reading'}
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 10 }}>SOURCE INCIDENT</Typography>
            <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>
              {context.location.sourceIncidentId ?? 'None'}
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 10 }}>COORDINATE</Typography>
            <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>
              {Number.isFinite(context.location.latitude)
                ? `${context.location.latitude.toFixed(4)}, ${context.location.longitude.toFixed(4)}`
                : 'No location'}
            </Typography>
          </Box>
        </Box>
      </Panel>

      <Panel title="Weather" action={<Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
        <CloudOutlinedIcon sx={{ fontSize: 15, color: 'text.secondary' }} />
        <Typography variant="caption" color="text.secondary">
          {weather.available ? 'Open-Meteo historical' : 'Unavailable'}
        </Typography>
      </Stack>}>
        {weather.available ? (
          <>
            <Typography variant="caption" color="text.secondary" component="div"
              sx={{ mb: 0.75, lineHeight: 1.45 }}>
              {weather.provenance}
            </Typography>
            <Stack spacing={0}>
              {weather.observations.map(entry => <Observation key={entry.label} entry={entry} />)}
            </Stack>
          </>
        ) : (
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'flex-start' }}>
            <WarningAmberOutlinedIcon sx={{ fontSize: 15, color: 'warning.main', mt: '2px' }} />
            <Typography sx={{ fontSize: 11.5, lineHeight: 1.5 }}>
              {weather.unavailableReason} Nothing has been substituted for it.
            </Typography>
          </Stack>
        )}
      </Panel>

      <Panel title="Traffic" action={<Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
        <TrafficOutlinedIcon sx={{ fontSize: 15, color: 'text.secondary' }} />
        <SyntheticMark origin="SYNTHETIC" synthetic />
      </Stack>}>
        <Box sx={{ mb: 1, px: 1.1, py: 0.85, borderRadius: 1, border: 1, borderColor: 'secondary.main',
          bgcolor: theme => `${theme.palette.secondary.main}12` }}>
          <Typography sx={{ fontSize: 11, lineHeight: 1.5 }}>
            {traffic.availability.note} Sources checked: {traffic.availability.checkedSources.join(', ')}.
          </Typography>
        </Box>
        <Stack spacing={0}>
          <Observation entry={traffic.speed} />
          <Observation entry={traffic.congestion} />
          <Observation entry={traffic.volume} />
        </Stack>
      </Panel>

      <Panel title="Recorded at the scene">
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.75, lineHeight: 1.45 }}>
          Real facts from the source incident's own register row and the FDOT road network. They
          describe that incident, not this case's synthetic damage.
        </Typography>
        <Stack spacing={0}>
          {traffic.register.map(entry => <Observation key={entry.label} entry={entry} />)}
          <Observation entry={traffic.annualAverage} />
        </Stack>
      </Panel>

      <Panel title="What this means for the work">
        <Stack spacing={0.6}>
          {context.implications.map(line => (
            <Stack key={line} direction="row" spacing={0.75} sx={{ alignItems: 'flex-start' }}>
              <InfoOutlinedIcon sx={{ fontSize: 13, color: 'info.main', mt: '2px' }} />
              <Typography sx={{ fontSize: 11.5, lineHeight: 1.55 }}>{line}</Typography>
            </Stack>
          ))}
        </Stack>
      </Panel>
    </Stack>
  );
}

/* --- the hooks the dialog uses -------------------------------------------------------------- */

/** Run the recovery search once the tab is opened, and hold the reviewer's decisions. */
export function useEvidenceRecovery(record, active) {
  const [state, setState] = useState({ recovery: null, loading: false });
  const [decisions, setDecisions] = useState({});
  const [applied, setApplied] = useState(null);
  const [orchestrator, setOrchestrator] = useState(null);

  const caseId = record?.demoCase?.demoCaseId ?? null;
  useEffect(() => { setDecisions({}); setApplied(null); }, [caseId]);

  useEffect(() => {
    if (!active || !record?.demoCase) return undefined;
    let live = true;
    setState({ recovery: null, loading: true });
    (async () => {
      const [{ createDemoConnectors }, { createCaseEnrichmentOrchestrator }, { evaluateDemoCase }] =
        await Promise.all([
          import('../acs/evidence/connectors.js'),
          import('../acs/evidence/orchestrator.js'),
          import('../acs/acsDemoCases.js'),
        ]);
      const engine = createCaseEnrichmentOrchestrator({
        connectors: createDemoConnectors({ maintenance: window.__maintenance ?? null }),
        evaluate: evaluateDemoCase,
      });
      const recovery = await engine.search(record.demoCase, record.evaluation).catch(() => null);
      if (!live) return;
      setOrchestrator(engine);
      setState({ recovery, loading: false });
      // Exact, unambiguous matches are offered already ticked. That is a proposal, not an
      // attachment: nothing reaches the case until Apply is pressed.
      setDecisions(Object.fromEntries((recovery?.gaps ?? [])
        .flatMap(gap => gap.preselected.map(recordId => [gap.fieldId, recordId]))));
    })();
    return () => { live = false; };
  }, [active, caseId]);

  const decide = useCallback((fieldId, recordId) => {
    setDecisions(current => ({ ...current, [fieldId]: recordId }));
    setApplied(null);
  }, []);

  const apply = useCallback(() => {
    if (!orchestrator || !state.recovery || !record) return;
    setApplied(orchestrator.apply(record.demoCase, record.evaluation, state.recovery, decisions));
  }, [orchestrator, state.recovery, record, decisions]);

  return { ...state, decisions, decide, apply, applied, audit: orchestrator?.audit ?? null };
}

/** Assemble the incident-time context once the tab is opened. */
export function useIncidentContext(record, active) {
  const [state, setState] = useState({ context: null, loading: false });
  const caseId = record?.demoCase?.demoCaseId ?? null;

  useEffect(() => {
    if (!active || !record?.demoCase) return undefined;
    let live = true;
    setState({ context: null, loading: true });
    (async () => {
      const { createIncidentContextService } = await import('../acs/incidentContext.js');
      const service = createIncidentContextService();
      const context = await service.contextFor(record.demoCase).catch(() => null);
      if (live) setState({ context, loading: false });
    })();
    return () => { live = false; };
  }, [active, caseId]);

  return state;
}

export const evidenceIndicatorLabel = outlook => (!outlook ? null : [
  outlook.missing ? `${outlook.missing} missing` : null,
  outlook.recoverable ? `${outlook.recoverable} recoverable` : null,
  outlook.unresolved ? `${outlook.unresolved} unresolved` : null,
].filter(Boolean).join(' · ') || 'Evidence complete');

export const useRecoveryMemo = outlook => useMemo(() => evidenceIndicatorLabel(outlook), [outlook]);
