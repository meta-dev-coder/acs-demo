/**
 * The QC/QA review, inside the ACS case.
 *
 * Five sub-sections — Overview, Checklist, Findings, Evidence, Approvals — over the result the
 * validation engine returned. The component renders findings; it decides nothing. Every status,
 * reason and recommended action on screen comes from `validationEngine.js`, so what a reviewer
 * reads here is exactly what the engine concluded.
 */
import { useEffect, useMemo, useState } from 'react';
import { Box, Chip, CircularProgress, Stack, Typography } from '@mui/material';
import CheckCircleOutlineOutlinedIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlineOutlined';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutlineOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import { STATUS } from '../qcqa/validationEngine.js';

/** One tone per status, used by the chips, the icons and the filters alike. */
export const STATUS_TONE = Object.freeze({
  [STATUS.PASS]: { color: 'success.main', label: 'Pass', Icon: CheckCircleOutlineOutlinedIcon },
  [STATUS.FAIL]: { color: 'error.main', label: 'Fail', Icon: ErrorOutlineIcon },
  [STATUS.MISSING]: { color: 'warning.main', label: 'Missing', Icon: WarningAmberOutlinedIcon },
  [STATUS.NEEDS_VERIFICATION]: { color: 'info.main', label: 'Needs verification', Icon: HelpOutlineIcon },
  [STATUS.NOT_APPLICABLE]: { color: 'text.disabled', label: 'N/A', Icon: RemoveCircleOutlineIcon },
  [STATUS.NOT_EVALUATED]: { color: 'text.secondary', label: 'Not evaluated', Icon: BlockOutlinedIcon },
});

const VIEWS = ['Overview', 'Checklist', 'Findings', 'Evidence', 'Approvals'];
const FILTERS = Object.freeze([
  { id: 'all', label: 'All' },
  { id: STATUS.FAIL, label: 'Failed' },
  { id: STATUS.MISSING, label: 'Missing' },
  { id: STATUS.NEEDS_VERIFICATION, label: 'Needs verification' },
  { id: STATUS.NOT_EVALUATED, label: 'Not evaluated' },
]);

function StatusChip({ status }) {
  const tone = STATUS_TONE[status] ?? STATUS_TONE[STATUS.NOT_EVALUATED];
  return (
    <Box component="span" sx={{
      px: 0.8, py: 0.15, borderRadius: 1, fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap',
      color: tone.color, border: 1, borderColor: tone.color,
    }}>{tone.label}</Box>
  );
}

function Panel({ title, children, action = null }) {
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 1.5 }}>
      {(title || action) && (
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 700 }}>{title}</Typography>
          {action}
        </Stack>
      )}
      {children}
    </Box>
  );
}

/** A count tile. Zero is drawn, not hidden — "0 passed" is the finding on this data. */
function Tile({ label, value, tone = 'text.primary' }) {
  return (
    <Box sx={{ p: 1, borderRadius: 1, border: 1, borderColor: 'divider', minWidth: 0 }}>
      <Typography sx={{ fontSize: 18, fontWeight: 700, lineHeight: 1.1, color: tone }}>{value}</Typography>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ lineHeight: 1.3 }}>
        {label}
      </Typography>
    </Box>
  );
}

/** One finding, with everything the spec requires on it. */
function Finding({ finding }) {
  const tone = STATUS_TONE[finding.status] ?? STATUS_TONE[STATUS.NOT_EVALUATED];
  return (
    <Box sx={{ py: 0.9, borderBottom: 1, borderColor: 'divider', '&:last-of-type': { borderBottom: 0 } }}>
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <tone.Icon sx={{ fontSize: 15, color: tone.color, mt: '2px', flexShrink: 0 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flexWrap: 'wrap', mb: 0.25 }}>
            <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{finding.question}</Typography>
            <StatusChip status={finding.status} />
          </Stack>
          <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 11, lineHeight: 1.5 }}>
            {finding.reason}
          </Typography>
          <Stack direction="row" spacing={1.5} sx={{ mt: 0.4, flexWrap: 'wrap' }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10.5 }}>
              Expected <strong>{finding.expected}</strong>
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10.5 }}>
              Actual <strong>{finding.actual ?? '—'}</strong>
            </Typography>
            {finding.sourceTemplate && (
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10.5 }}>
                {finding.sourceTemplate} p.{finding.sourcePage}
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10.5, fontFamily: 'monospace' }}>
              {finding.mappedField}
            </Typography>
          </Stack>
          {finding.columns && (
            <Stack direction="row" spacing={1} sx={{ mt: 0.4 }}>
              {finding.columns.map(column => (
                <Typography key={column.key} variant="caption" sx={{ fontSize: 10.5 }}>
                  {column.label}: <strong>{column.answer ?? '—'}</strong>
                </Typography>
              ))}
            </Stack>
          )}
          {finding.recommendedAction && (
            <Typography variant="caption" component="div"
              sx={{ fontSize: 10.5, mt: 0.4, color: 'info.main' }}>
              → {finding.recommendedAction}
            </Typography>
          )}
        </Box>
      </Stack>
    </Box>
  );
}

/**
 * @param {{review: object|null, loading: boolean}} props
 *   `review` is what `reviewRecord` returned.
 */
export function QcQaSection({ review, loading = false }) {
  const [view, setView] = useState('Overview');
  const [filter, setFilter] = useState('all');
  useEffect(() => { setView('Overview'); setFilter('all'); }, [review?.result?.caseId]);

  const result = review?.result ?? null;
  const allFindings = useMemo(() => (result
    ? [...result.templates.flatMap(entry => entry.findings), ...result.consistency] : []), [result]);
  const shown = useMemo(() => (filter === 'all'
    ? allFindings : allFindings.filter(entry => entry.status === filter)), [allFindings, filter]);

  if (loading) {
    return (
      <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 2 }}>
        <CircularProgress size={16} />
        <Typography variant="body2" color="text.secondary">Running the QC/QA validation…</Typography>
      </Stack>
    );
  }
  if (!result) {
    return (
      <Panel title="QC/QA">
        <Typography sx={{ fontSize: 12, color: 'warning.main' }}>
          No QC/QA review could be produced for this record.
        </Typography>
      </Panel>
    );
  }

  const { selection, summary } = result;

  const body = () => {
    switch (view) {
      case 'Checklist':
        return (
          <Stack spacing={1.5}>
            {result.templates.map(entry => (
              <Panel key={entry.templateId}
                title={`${entry.templateId} — ${entry.title}`}
                action={<Chip size="small" variant="outlined" label={entry.inclusion === 'UNIVERSAL'
                  ? 'Universal' : 'Selected'} sx={{ height: 19, fontSize: 10 }} />}>
                <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.75 }}>
                  v{entry.version} · {entry.source.file} p.{entry.source.page} ·
                  {' '}{entry.summary.total} checks
                </Typography>
                <Box>
                  {entry.findings.map(finding => (
                    <Finding key={finding.ruleId} finding={finding} />
                  ))}
                </Box>
              </Panel>
            ))}
          </Stack>
        );

      case 'Findings':
        return (
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
              {FILTERS.map(entry => {
                const count = entry.id === 'all' ? allFindings.length
                  : allFindings.filter(finding => finding.status === entry.id).length;
                return (
                  <Chip key={entry.id} size="small" label={`${entry.label} (${count})`}
                    onClick={() => setFilter(entry.id)}
                    color={filter === entry.id ? 'primary' : 'default'}
                    variant={filter === entry.id ? 'filled' : 'outlined'}
                    sx={{ height: 22, fontSize: 10.5 }} />
                );
              })}
            </Stack>
            <Panel title={`${shown.length} finding${shown.length === 1 ? '' : 's'}`}>
              {shown.length
                ? shown.map(finding => <Finding key={finding.ruleId} finding={finding} />)
                : <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
                    Nothing in this category.
                  </Typography>}
            </Panel>
          </Stack>
        );

      case 'Evidence': {
        const evidence = allFindings.filter(finding =>
          finding.validationType === 'EVIDENCE_AVAILABILITY');
        return (
          <Panel title="Evidence required by the selected checklists">
            {evidence.length
              ? evidence.map(finding => <Finding key={finding.ruleId} finding={finding} />)
              : <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
                  None of the selected checklists names a specific evidence requirement.
                </Typography>}
          </Panel>
        );
      }

      case 'Approvals': {
        const approvals = allFindings.filter(finding =>
          finding.validationType === 'APPROVAL_COMPLETENESS');
        return (
          <Stack spacing={1.5}>
            <Panel title="QC and QA sign-off">
              {approvals.map(finding => <Finding key={finding.ruleId} finding={finding} />)}
            </Panel>
            <Box sx={{ p: 1.25, borderRadius: 1.5, border: 1, borderColor: 'warning.main',
              bgcolor: theme => `${theme.palette.warning.main}14` }}>
              <Typography variant="body2" sx={{ fontSize: 11.5, lineHeight: 1.5 }}>
                A checklist is never shown as approved without an actual approval record. No class
                in this twin holds one, so every sign-off above is outstanding — that is the state
                of the paperwork, not a judgement about the work.
              </Typography>
            </Box>
          </Stack>
        );
      }

      default:
        return (
          <Stack spacing={1.5}>
            <Panel title="Checklist selection">
              <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.5, flexWrap: 'wrap' }}>
                {selection.selectedTemplates.length
                  ? selection.selectedTemplates.map(id => (
                    <Chip key={id} size="small" label={id} color="primary" variant="outlined"
                      sx={{ height: 20, fontSize: 10.5 }} />))
                  : <Chip size="small" label="Unresolved" color="warning" variant="outlined"
                      sx={{ height: 20, fontSize: 10.5 }} />}
                <Chip size="small" label={selection.confidence}
                  color={selection.confidence === 'HIGH' ? 'success'
                    : selection.confidence === 'UNRESOLVED' ? 'warning' : 'info'}
                  variant="outlined" sx={{ height: 20, fontSize: 10.5 }} />
                {selection.requiresConfirmation && (
                  <Chip size="small" label="Reviewer confirmation required" color="warning"
                    sx={{ height: 20, fontSize: 10.5 }} />
                )}
              </Stack>
              <Typography variant="body2" sx={{ fontSize: 12, lineHeight: 1.55 }}>
                {selection.selectionReason}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.75 }}>
                Selected from asset type <strong>{selection.basis.assetType ?? '—'}</strong>,
                subtype <strong>{selection.basis.assetSubtype ?? '—'}</strong>,
                activity <strong>{selection.basis.workActivity ?? '—'}</strong>.
                The incident type is recorded but is never used to choose a checklist.
              </Typography>
            </Panel>

            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 1 }}>
              <Tile label="Applicable checks" value={summary.applicable} />
              <Tile label="Passed" value={summary.PASS} tone="success.main" />
              <Tile label="Failed" value={summary.FAIL} tone="error.main" />
              <Tile label="Missing" value={summary.MISSING} tone="warning.main" />
              <Tile label="Needs verification" value={summary.NEEDS_VERIFICATION} tone="info.main" />
              <Tile label="Not applicable" value={summary.NOT_APPLICABLE} tone="text.disabled" />
              <Tile label="Not evaluated" value={summary.NOT_EVALUATED} tone="text.secondary" />
            </Box>

            <Panel title="Source documents">
              <Stack spacing={0.4}>
                {result.templates.map(entry => (
                  <Typography key={entry.templateId} variant="caption" component="div"
                    sx={{ fontSize: 11 }}>
                    <strong>{entry.templateId}</strong> v{entry.version} — {entry.source.file}
                    {' '}p.{entry.source.page}
                    {entry.inclusion === 'UNIVERSAL' ? ' (applies to every job)' : ''}
                  </Typography>
                ))}
              </Stack>
            </Panel>

            {summary.MISSING > 0 && (
              <Box sx={{ p: 1.25, borderRadius: 1.5, border: 1, borderColor: 'warning.main',
                bgcolor: theme => `${theme.palette.warning.main}14` }}>
                <Typography variant="body2" sx={{ fontSize: 11.5, lineHeight: 1.5 }}>
                  <strong>{summary.MISSING} checks are missing a response.</strong> Missing means
                  the paperwork was not captured — it is not a failed inspection and says nothing
                  about the condition of the asset. The ACS QC/QA checklist responses are not held
                  by any system currently connected.
                </Typography>
              </Box>
            )}
          </Stack>
        );
    }
  };

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
        {VIEWS.map(name => (
          <Chip key={name} size="small" label={name} onClick={() => setView(name)}
            color={view === name ? 'primary' : 'default'}
            variant={view === name ? 'filled' : 'outlined'} sx={{ height: 22, fontSize: 10.5 }} />
        ))}
      </Stack>
      {body()}
      <Typography variant="caption" color="text.secondary" component="div" sx={{ lineHeight: 1.5 }}>
        Evaluated by the ACS QC/QA validation framework against the extracted checklist templates.
        The engine reports the state of the record; it does not inspect the asset.
      </Typography>
    </Stack>
  );
}
