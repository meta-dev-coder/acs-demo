/**
 * The ACS case behind an incident: what was inspected, what was repaired, and what the form did
 * not capture.
 *
 * Everything in the case is a real ACS form submission — the inspector, the dates, the damage
 * description, the photo counts, the third-party invoice. Two things are not, and both say so on
 * screen rather than in a comment:
 *
 *  - **The pairing.** No field in the ACS form appears in the incident register, so a case is
 *    attached to an incident for illustration. The header carries that badge on every case until
 *    ACS supplies the Event # (see `acsCases.js`).
 *  - **The resources.** Labour, service vehicle, equipment and materials are referenced by the
 *    form and were not flattened into the export. They are drawn as "Not recorded", never as 0 —
 *    a zero would read as "no crew attended", which is a different and false claim.
 */
import { useEffect, useState } from 'react';
import {
  Box, Button, Chip, Dialog, DialogContent, Divider, IconButton, Stack, Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import VerifiedOutlinedIcon from '@mui/icons-material/VerifiedOutlined';
import GavelOutlinedIcon from '@mui/icons-material/GavelOutlined';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import TravelExploreOutlinedIcon from '@mui/icons-material/TravelExploreOutlined';
import CloudOutlinedIcon from '@mui/icons-material/CloudOutlined';
import PhotoLibraryOutlinedIcon from '@mui/icons-material/PhotoLibraryOutlined';
import PersonOutlineIcon from '@mui/icons-material/PersonOutlineOutlined';
import LocalShippingOutlinedIcon from '@mui/icons-material/LocalShippingOutlined';
import HandymanOutlinedIcon from '@mui/icons-material/HandymanOutlined';
import InventoryOutlinedIcon from '@mui/icons-material/InventoryOutlined';
import {
  CASE_EVIDENCE, DOC_STATE, claimReadiness, qcStatus, repairSummary, stageOf,
} from '../acs/acsCases.js';
import { STAGE_ORDER, STAGE_PRESENTATION } from '../acs/acsDemoCases.js';
import { STAGE_LABELS, STATUS } from '../qcqa/stageValidation.js';
import { QcQaSection, STATUS_TONE } from './QcQaSection.jsx';
import {
  EvidenceRecoveryTab, IncidentContextTab, useEvidenceRecovery, useIncidentContext,
} from './DemoEvidenceTabs.jsx';

const SECTIONS = Object.freeze([
  { id: 'overview', label: 'Overview', Icon: ArticleOutlinedIcon },
  { id: 'inspection', label: 'Inspection', Icon: FactCheckOutlinedIcon },
  { id: 'repair', label: 'Repair', Icon: BuildOutlinedIcon },
  { id: 'qc', label: 'QC/QA', Icon: VerifiedOutlinedIcon },
  { id: 'claims', label: 'Claims', Icon: GavelOutlinedIcon },
  { id: 'assets', label: 'Related Assets', Icon: AccountTreeOutlinedIcon },
]);

/** The demo case's own sections: one per lifecycle stage, plus the audit trail. */
const DEMO_SECTIONS = Object.freeze([
  { id: 'overview', label: 'Overview', Icon: ArticleOutlinedIcon },
  { id: 'inspection', label: 'Inspection', Icon: FactCheckOutlinedIcon },
  { id: 'repair', label: 'Repair', Icon: BuildOutlinedIcon },
  { id: 'qc', label: 'QC/QA', Icon: VerifiedOutlinedIcon },
  // The two enrichment tabs sit between the physical stages and the claim: recovering the missing
  // documents and reading the conditions at the time are both steps a reviewer takes BEFORE
  // deciding whether the claim is ready, so the tab order is the order of the work.
  { id: 'evidence', label: 'Evidence Recovery', Icon: TravelExploreOutlinedIcon },
  { id: 'context', label: 'Incident Context', Icon: CloudOutlinedIcon },
  { id: 'claim', label: 'Claims', Icon: GavelOutlinedIcon },
  { id: 'audit', label: 'Audit Trail', Icon: AccountTreeOutlinedIcon },
]);

const RESOURCE_ICONS = {
  labourHours: PersonOutlineIcon,
  serviceVehicle: LocalShippingOutlinedIcon,
  equipment: HandymanOutlinedIcon,
  materials: InventoryOutlinedIcon,
};

const dateLabel = value => {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value
    : parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const money = value => `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

/** A label over a value, or over the reason there is no value. */
function Field({ label, value, absent = null }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" component="div"
        sx={{ textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 10 }}>
        {label}
      </Typography>
      {value != null && value !== ''
        ? <Typography sx={{ fontSize: 13, fontWeight: 600, wordBreak: 'break-word' }}>{value}</Typography>
        : (
          <Typography sx={{ fontSize: 12, fontWeight: 500, color: 'warning.main', display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <WarningAmberOutlinedIcon sx={{ fontSize: 13 }} />
            {absent ?? 'Not recorded'}
          </Typography>
        )}
    </Box>
  );
}

/** A bordered block with a heading, used for every group in the body. */
function Panel({ title, action = null, children }) {
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

/**
 * The resource strip.
 *
 * Four tiles, and on today's export all four are absent. They are still drawn, because a missing
 * tile says nothing while a tile reading "Not recorded" says the form has a field for this and it
 * came through empty — which is the finding.
 */
function Resources({ absentFields }) {
  return (
    <Panel title="Resources Recorded">
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))', gap: 1 }}>
        {absentFields.map(({ key, label }) => {
          const Icon = RESOURCE_ICONS[key] ?? InventoryOutlinedIcon;
          return (
            <Box key={key} sx={{ p: 1, borderRadius: 1, border: 1, borderColor: 'divider', minWidth: 0 }}>
              <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.25 }}>
                <Icon sx={{ fontSize: 15, color: 'text.secondary' }} />
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: 11 }}>{label}</Typography>
              </Stack>
              <Typography sx={{ fontSize: 12, fontWeight: 600, color: 'warning.main', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <WarningAmberOutlinedIcon sx={{ fontSize: 13 }} /> Not recorded
              </Typography>
            </Box>
          );
        })}
      </Box>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1, lineHeight: 1.5 }}>
        The form references labour, equipment, MOT and material sub-tables. They were not included
        in the export and <strong>Total Cost is empty on every row</strong>, so these are absent
        rather than zero. No cost total can be produced for this task.
      </Typography>
    </Panel>
  );
}

/** Photo counts. The form recorded how many were taken; the files were never supplied. */
function Photos({ stage }) {
  const count = (stage?.inspectionPhotos ?? 0) + (stage?.repairPhotos ?? 0);
  return (
    <Panel title="Photos">
      {count > 0 ? (
        <>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(76px, 1fr))', gap: 1 }}>
            {Array.from({ length: Math.min(count, 8) }, (unused, index) => (
              <Box key={index} sx={{
                aspectRatio: '4 / 3', borderRadius: 1, border: 1, borderColor: 'divider',
                display: 'grid', placeItems: 'center', bgcolor: 'action.hover',
              }}>
                <PhotoLibraryOutlinedIcon sx={{ fontSize: 18, color: 'text.disabled' }} />
              </Box>
            ))}
          </Box>
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
            {count} photo{count === 1 ? '' : 's'} recorded on this form. The image files were not
            supplied with the export, so the frames above are placeholders for them.
          </Typography>
        </>
      ) : (
        <Typography sx={{ fontSize: 12, color: 'warning.main', display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <WarningAmberOutlinedIcon sx={{ fontSize: 14 }} /> No photos recorded on this form.
        </Typography>
      )}
    </Panel>
  );
}

/** The completeness check. Findings about the record, never a judgement about the work. */
function DataCheck({ findings }) {
  return (
    <Box sx={{
      border: 1, borderColor: 'info.main', borderRadius: 1.5, p: 1.5,
      bgcolor: theme => `${theme.palette.info.main}14`,
    }}>
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.75 }}>
        <InfoOutlinedIcon sx={{ fontSize: 16, color: 'info.main' }} />
        <Typography sx={{ fontSize: 13, fontWeight: 700, color: 'info.main' }}>Data check</Typography>
      </Stack>
      <Stack spacing={0.75}>
        {findings.map(finding => (
          <Stack key={finding.text} direction="row" spacing={0.75} alignItems="flex-start">
            {finding.kind === 'present'
              ? <CheckCircleOutlineIcon sx={{ fontSize: 14, color: 'success.main', mt: '2px' }} />
              : <WarningAmberOutlinedIcon sx={{ fontSize: 14, color: 'warning.main', mt: '2px' }} />}
            <Typography variant="body2" sx={{ fontSize: 12, lineHeight: 1.5 }}>{finding.text}</Typography>
          </Stack>
        ))}
      </Stack>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
        A completeness check over the fields of this form. It does not assess the work done.
      </Typography>
    </Box>
  );
}

/** One work stage — inspection, repair or QC — as filed. */
function StageBody({ stage, kind, task, absentFields }) {
  if (!stage) {
    return (
      <Panel title={`${kind} stage`}>
        <Typography sx={{ fontSize: 12, color: 'warning.main', display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <WarningAmberOutlinedIcon sx={{ fontSize: 14 }} />
          No {kind.toLowerCase()} stage has been filed for task {task.taskNumber}.
        </Typography>
      </Panel>
    );
  }
  return (
    <Stack spacing={1.5}>
      <Panel title={`Field ${kind.toLowerCase()}`}>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: 1.25 }}>
          <Field label="Task No." value={task.taskNumber} />
          <Field label={`${kind} date`} value={dateLabel(stage.date)} />
          <Field label="Asset type" value={task.assetTypeHint?.split('\t')[0] ?? null} />
          <Field label="Inspector" value={stage.inspector} />
        </Box>
      </Panel>

      <Panel title={kind === 'Repair' ? 'Work performed' : 'Damage description'}>
        <Typography variant="body2" sx={{ fontSize: 12.5, lineHeight: 1.6 }}>
          {stage.workDescription ?? stage.itemsRepaired ?? 'No description was entered on this form.'}
        </Typography>
        {stage.itemsRepaired && stage.workDescription && (
          <Typography variant="body2" sx={{ fontSize: 12.5, lineHeight: 1.6, mt: 0.75 }}>
            <strong>Items:</strong> {stage.itemsRepaired}
          </Typography>
        )}
        {stage.repairBy && (
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.75 }}>
            Repair by {stage.repairBy}
          </Typography>
        )}
      </Panel>

      <Resources absentFields={absentFields} />
      <Photos stage={stage} />
    </Stack>
  );
}

/**
 * The case.
 *
 * @param {object|null} acsCase from `caseForIncident`
 * @param {object} incident the record the case was opened from
 */
/* --- Repair, QC/QA and Claims ---------------------------------------------------------------- */

const DOC_TONE = {
  [DOC_STATE.AVAILABLE]: { color: 'success.main', label: 'Available' },
  [DOC_STATE.VERIFY]: { color: 'info.main', label: 'Verify' },
  [DOC_STATE.PENDING]: { color: 'warning.main', label: 'Pending' },
  [DOC_STATE.MISSING]: { color: 'error.main', label: 'Missing' },
};

/** A status pill carrying its own colour. */
function Pill({ tone, children }) {
  return (
    <Box component="span" sx={{
      px: 0.9, py: 0.2, borderRadius: 1, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap',
      // A pill sizes to its own text. Without this it inherits the flex row's `stretch` and grows
      // to the height of the longest cell beside it — `Stack` quietly drops an `alignItems` prop,
      // so the row cannot be relied on to have set it.
      alignSelf: 'flex-start', flex: 'none', lineHeight: 1.5,
      color: tone, border: 1, borderColor: tone,
      bgcolor: theme => `${theme.palette[String(tone).split('.')[0]]?.main ?? 'transparent'}14`,
    }}>{children}</Box>
  );
}

/** Repair: what was done, when, and by whom — plus the resource lines the export omits. */
function RepairSection({ task, record, absentFields }) {
  const summary = repairSummary(task, record);
  if (!summary.workPerformed && !summary.completedDate) {
    return (
      <Panel title="Repair">
        <Typography sx={{ fontSize: 12, color: 'warning.main', display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <WarningAmberOutlinedIcon sx={{ fontSize: 14 }} />
          No repair stage has been filed for task {task.taskNumber}. Only an inspection exists.
        </Typography>
      </Panel>
    );
  }
  return (
    <Stack spacing={1.5}>
      <Panel title="Repair details">
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(128px, 1fr))', gap: 1.25 }}>
          <Field label="Work order" value={summary.workOrderId}
            absent={`Not on the form — ACS task ${summary.taskNumber}`} />
          <Field label="Work performed" value={summary.workPerformed} />
          <Field label="Completed date" value={dateLabel(summary.completedDate)} />
          <Field label="Repair by" value={summary.repairBy} />
        </Box>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.25 }}>
          <Typography variant="caption" color="text.secondary">Status</Typography>
          <Pill tone={summary.statusIsFiledNotVerified ? 'warning.main' : 'success.main'}>
            {summary.status}
          </Pill>
        </Stack>
        {summary.statusIsFiledNotVerified && (
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.75 }}>
            The repair stage was filed; no QC stage follows it, so completion is recorded rather
            than verified.
          </Typography>
        )}
      </Panel>

      <Resources absentFields={absentFields} />

      {summary.itemsRepaired && (
        <Panel title="Notes">
          <Typography variant="body2" sx={{ fontSize: 12.5, lineHeight: 1.6 }}>
            {summary.itemsRepaired}
          </Typography>
        </Panel>
      )}

      <Photos stage={{ inspectionPhotos: summary.photos, repairPhotos: 0 }} />
    </Stack>
  );
}

/** QC/QA: the state of the stage, and an honest account of the checklist that is not in the export. */
function QcSection({ task }) {
  const qc = qcStatus(task);
  return (
    <Stack spacing={1.5}>
      <Panel title="QC / QA status">
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 1.25 }}>
          <Box>
            <Typography variant="caption" color="text.secondary" component="div"
              sx={{ textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 10, mb: 0.4 }}>
              QC status
            </Typography>
            <Pill tone={qc.qcState === 'FILED' ? 'success.main' : 'warning.main'}>{qc.qcLabel}</Pill>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary" component="div"
              sx={{ textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 10, mb: 0.4 }}>
              QA status
            </Typography>
            <Pill tone={qc.qaState === 'PENDING' ? 'warning.main' : 'text.secondary'}>{qc.qaLabel}</Pill>
          </Box>
          <Field label="Signed by" value={qc.signatory} absent="No QC signatory on this form" />
          <Field label="QC date" value={dateLabel(qc.qcDate)} />
        </Box>
      </Panel>

      <Panel title="Checklist results">
        <Stack direction="row" spacing={0.75} alignItems="flex-start">
          <WarningAmberOutlinedIcon sx={{ fontSize: 15, color: 'warning.main', mt: '2px' }} />
          <Typography variant="body2" sx={{ fontSize: 12.5, lineHeight: 1.6 }}>
            {qc.checklistNote}
          </Typography>
        </Stack>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1, lineHeight: 1.5 }}>
          To show per-item pass/fail here, ACS would need to export the QC/QA checklist rows —
          the item text, the result and the inspector's comment — alongside the task. The layout
          for them is built; only the data is missing, and inventing plausible results would make
          this panel indistinguishable from a real one.
        </Typography>
      </Panel>
    </Stack>
  );
}

/** Claims: can this task support a claim, judged only on the documents that exist. */
function ClaimsSection({ task }) {
  const review = claimReadiness(task);
  return (
    <Stack spacing={1.5}>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 1.25 }}>
        <Box sx={{ p: 1.5, borderRadius: 1.5, border: 1, borderColor: 'success.main',
          bgcolor: theme => `${theme.palette.success.main}12` }}>
          <Typography variant="caption" color="text.secondary" component="div">Documented costs</Typography>
          <Typography sx={{ fontSize: 22, fontWeight: 700 }}>
            {review.documentedUSD > 0 ? money(review.documentedUSD) : '—'}
          </Typography>
          <Typography variant="caption" color="text.secondary" component="div">
            {review.documentedUSD > 0
              ? 'Third-party invoice only'
              : 'No cost of any kind is recorded'}
          </Typography>
        </Box>
        <Box sx={{ p: 1.5, borderRadius: 1.5, border: 1, borderColor: 'error.main',
          bgcolor: theme => `${theme.palette.error.main}12` }}>
          <Typography variant="caption" color="text.secondary" component="div">Undocumented</Typography>
          <Typography sx={{ fontSize: 22, fontWeight: 700, color: 'error.main' }}>
            {review.missingCount} missing
          </Typography>
          <Typography variant="caption" color="text.secondary" component="div">
            documents, of {review.rows.length} checked
          </Typography>
        </Box>
      </Box>

      <Panel title="Documentation checklist">
        <Stack spacing={0.5}>
          {review.rows.map(row => {
            const tone = DOC_TONE[row.state];
            return (
              <Stack key={row.label} direction="row" spacing={1} alignItems="center"
                sx={{ py: 0.6, borderBottom: 1, borderColor: 'divider', '&:last-of-type': { borderBottom: 0 } }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{row.label}</Typography>
                  <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 11 }}>
                    {row.note}
                  </Typography>
                </Box>
                <Pill tone={tone.color}>{tone.label}</Pill>
              </Stack>
            );
          })}
        </Stack>
      </Panel>

      <Panel title="Claim package">
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.75 }}>
          <Typography sx={{ fontSize: 12.5 }}>Ready to submit</Typography>
          <Pill tone={review.ready ? 'success.main' : 'error.main'}>{review.ready ? 'Yes' : 'No'}</Pill>
        </Stack>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ lineHeight: 1.6 }}>
          <strong>Value of what is undocumented:</strong> {review.undocumentedCostNote}
        </Typography>
      </Panel>
    </Stack>
  );
}


/* --- the demo cases ---------------------------------------------------------------------------
 *
 * One synthetic lifecycle per case. Every status drawn below was DERIVED by the shared validation
 * engine from the field data in `data/acs-demo-cases.json`; nothing here reads a status out of the
 * file. The components are the same ones the real ACS case uses — Field, Panel, Pill and the
 * QC/QA review — because a demo case is meant to show what this screen looks like with a complete
 * record set, not to be a second screen.
 */

const TONE_OF = { ok: 'success.main', warn: 'warning.main', bad: 'error.main',
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

/** The lifecycle, as a row of four states. */
function DemoStageStrip({ evaluation }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: `repeat(${STAGE_ORDER.length}, 1fr)`, gap: 1 }}>
      {STAGE_ORDER.map(key => {
        const stage = evaluation.stages[key];
        const tone = STAGE_PRESENTATION[stage.status] ?? STAGE_PRESENTATION.PENDING;
        return (
          <Box key={key} sx={{ p: 1, borderRadius: 1, border: 1, borderColor: TONE_OF[tone.tone] ?? 'divider',
            bgcolor: theme => `${theme.palette[String(TONE_OF[tone.tone] ?? '').split('.')[0]]?.main ?? 'transparent'}10` }}>
            <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 10 }}>
              {STAGE_LABELS[key]}
            </Typography>
            <Typography sx={{ fontSize: 12.5, fontWeight: 700, color: TONE_OF[tone.tone] ?? 'text.primary' }}>
              {tone.label}
            </Typography>
            {stage.gatedBy && (
              <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 9.5 }}>
                held by {STAGE_LABELS[stage.gatedBy].toLowerCase()}
              </Typography>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/** The counts for one stage. Zeroes are drawn: "0 recorded" is the finding on a blocked stage. */
function DemoStageSummary({ stage }) {
  const tiles = [
    ['Passed', stage.summary.passed, 'success.main'],
    ['Failed', stage.summary.failed, 'error.main'],
    ['Missing', stage.summary.missing, 'warning.main'],
    ['Pending', stage.summary.pending, 'info.main'],
    ['Blocked', stage.summary.blocked, 'error.main'],
    ['N/A', stage.summary.notApplicable, 'text.disabled'],
  ];
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(74px, 1fr))', gap: 0.75 }}>
      {tiles.map(([label, value, tone]) => (
        <Box key={label} sx={{ p: 0.75, borderRadius: 1, border: 1, borderColor: 'divider' }}>
          <Typography sx={{ fontSize: 16, fontWeight: 700, lineHeight: 1.1, color: value ? tone : 'text.disabled' }}>
            {value}
          </Typography>
          <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 10 }}>{label}</Typography>
        </Box>
      ))}
    </Box>
  );
}

/** Every field of one stage, with the status the engine gave it and the reason for that status. */
function DemoFields({ fields }) {
  if (!fields.length) {
    return (
      <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
        This stage holds no record at all, so there is nothing to validate.
      </Typography>
    );
  }
  return (
    <Stack spacing={0}>
      {fields.map(field => {
        const tone = STATUS_TONE[field.status]
          ?? (field.status === STATUS.PENDING ? { color: 'info.main', label: 'Pending' }
            : { color: 'error.main', label: 'Blocked' });
        return (
          <Stack key={field.fieldId} direction="row" spacing={1}
            sx={{ alignItems: 'flex-start', py: 0.75, borderBottom: 1, borderColor: 'divider',
              '&:last-of-type': { borderBottom: 0 } }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>
                {field.label}{field.required ? '' : ' (optional)'}
              </Typography>
              <Typography sx={{ fontSize: 11.5, color: field.value == null ? 'text.disabled' : 'text.primary',
                overflowWrap: 'anywhere' }}>
                {field.value == null ? '— not recorded —'
                  : field.dataType === 'date' ? dateTime(field.value)
                    : `${field.value}${field.unit ? ` ${field.unit}` : ''}`}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 10.5, lineHeight: 1.45 }}>
                {field.message}
              </Typography>
            </Box>
            <Pill tone={tone.color}>{tone.label}</Pill>
          </Stack>
        );
      })}
    </Stack>
  );
}

/** Phase 9: what was detected, why it matters, what to do — generated from the findings. */
function DemoExplanation({ explanation }) {
  const rows = [
    ['What did the system detect?', explanation.detection],
    ['Why does it matter?', explanation.impact],
    ['What action is required?', explanation.action],
  ];
  return (
    <Box sx={{ border: 1, borderColor: 'info.main', borderRadius: 1.5, p: 1.5,
      bgcolor: theme => `${theme.palette.info.main}12` }}>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 1 }}>
        <InfoOutlinedIcon sx={{ fontSize: 16, color: 'info.main' }} />
        <Typography sx={{ fontSize: 13, fontWeight: 700, color: 'info.main' }}>What this case shows</Typography>
      </Stack>
      <Stack spacing={1}>
        {rows.map(([question, answer]) => (
          <Box key={question}>
            <Typography sx={{ fontSize: 11.5, fontWeight: 700 }}>{question}</Typography>
            <Typography sx={{ fontSize: 12, lineHeight: 1.55 }}>{answer}</Typography>
          </Box>
        ))}
      </Stack>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1, lineHeight: 1.45 }}>
        Written from this case's own validation findings by a fixed rule, not by a language model.
      </Typography>
    </Box>
  );
}

/** One stage's tab: its state, its counts, its own record and its fields. */
function DemoStageBody({ stage, label, children = null }) {
  const tone = STAGE_PRESENTATION[stage.status] ?? STAGE_PRESENTATION.PENDING;
  return (
    <Stack spacing={1.5}>
      <Panel title={`${label} — ${tone.label}`}>
        <DemoStageSummary stage={stage} />
        {stage.gatedBy && (
          <Typography sx={{ fontSize: 12, color: 'error.main', mt: 1, display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <WarningAmberOutlinedIcon sx={{ fontSize: 14 }} />
            Held by the {STAGE_LABELS[stage.gatedBy].toLowerCase()} stage, which failed validation.
            Nothing is outstanding from this team until that is put right.
          </Typography>
        )}
        {stage.record?.note && (
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1, lineHeight: 1.5 }}>
            {stage.record.note}
          </Typography>
        )}
        {stage.record?.progressNote && (
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1, lineHeight: 1.5 }}>
            Progress: {stage.record.progressNote}
          </Typography>
        )}
      </Panel>
      {children}
      <Panel title="Fields and validation">
        <DemoFields fields={stage.fields} />
      </Panel>
    </Stack>
  );
}

/** The QC/QA tab: the engine's own review, plus the non-conformances and measurements. */
function DemoQcBody({ demoCase, evaluation }) {
  const qa = demoCase.qualityAssurance;
  return (
    <Stack spacing={1.5}>
      <Panel title="Checklist applied">
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 1.25 }}>
          <Field label="Checklist" value={evaluation.checklist.declared} />
          <Field label="Title" value={evaluation.checklist.declaredTitle} />
          <Field label="Reviewer" value={qa.reviewer} />
          <Field label="Reviewed" value={dateTime(qa.reviewedAt)} />
        </Box>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1, lineHeight: 1.5 }}>
          The selection engine, run over this case's asset type and work activity, would choose{' '}
          {evaluation.checklist.engineSelection.selectedTemplates.join(', ') || 'no checklist'}.{' '}
          {evaluation.checklist.agrees
            ? 'That includes the one the case was inspected against.'
            : 'That does NOT include the one the case was inspected against, which is a disagreement worth reading.'}
        </Typography>
      </Panel>

      {evaluation.review
        ? <QcQaSection review={{ result: evaluation.review }} />
        : (
          <Panel title="QC/QA inspection">
            <Typography sx={{ fontSize: 12, color: 'warning.main', display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
              <WarningAmberOutlinedIcon sx={{ fontSize: 14, mt: '2px' }} />
              No QC/QA inspection has been submitted for this case, so there are no checklist
              responses to evaluate. The checklist is not being shown as failed — it has not been
              answered.
            </Typography>
            {qa.reviewerNotes && (
              <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1, lineHeight: 1.5 }}>
                {qa.reviewerNotes}
              </Typography>
            )}
          </Panel>
        )}

      {Boolean(qa.measurements?.length) && (
        <Panel title="Measurements">
          <Stack spacing={0}>
            {qa.measurements.map(entry => (
              <Box key={entry.label} sx={{ py: 0.75, borderBottom: 1, borderColor: 'divider',
                '&:last-of-type': { borderBottom: 0 } }}>
                <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{entry.label}</Typography>
                <Typography sx={{ fontSize: 12 }}>
                  Observed {entry.observed}{entry.unit ? ` ${entry.unit}` : ''} · acceptance: {entry.acceptance}
                </Typography>
                {entry.demonstrationOnly && (
                  <Typography sx={{ fontSize: 10.5, color: 'warning.main', display: 'flex', alignItems: 'center', gap: 0.4 }}>
                    <WarningAmberOutlinedIcon sx={{ fontSize: 12 }} />
                    Demonstration-only threshold. The ACS checklist states no figure for this item;
                    the one quoted is an assumption so the measurement can be compared with something.
                  </Typography>
                )}
                {entry.note && (
                  <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 10.5, lineHeight: 1.45 }}>
                    {entry.note}
                  </Typography>
                )}
              </Box>
            ))}
          </Stack>
        </Panel>
      )}

      <Panel title={`Non-conformances (${qa.nonConformances?.length ?? 0})`}>
        {qa.nonConformances?.length ? (
          <Stack spacing={1}>
            {qa.nonConformances.map(entry => (
              <Box key={entry.id} sx={{ p: 1, borderRadius: 1, border: 1, borderColor: 'divider' }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.4 }}>
                  <Typography sx={{ fontSize: 12, fontWeight: 700 }}>{entry.id}</Typography>
                  <Pill tone={entry.severity === 'CRITICAL' ? 'error.main' : 'warning.main'}>{entry.severity}</Pill>
                  <Pill tone={entry.status === 'OPEN' ? 'error.main' : 'success.main'}>{entry.status}</Pill>
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>{entry.question}</Typography>
                </Stack>
                <Typography sx={{ fontSize: 12, lineHeight: 1.5 }}>{entry.finding}</Typography>
                <Typography sx={{ fontSize: 11.5, lineHeight: 1.5, mt: 0.4 }}>
                  <strong>Corrective action:</strong> {entry.correctiveAction}
                </Typography>
              </Box>
            ))}
          </Stack>
        ) : (
          <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
            None raised against this case.
          </Typography>
        )}
      </Panel>

      {qa.reviewerNotes && evaluation.review && (
        <Panel title="Reviewer notes">
          <Typography sx={{ fontSize: 12.5, lineHeight: 1.6 }}>{qa.reviewerNotes}</Typography>
        </Panel>
      )}

      {/* No "fields" panel here. A QC/QA record is not a form of its own — it is the answers to a
          checklist, and the review above already lists every one of them with its status, its
          expected answer and the page of the PDF it came from. */}
    </Stack>
  );
}

/** The claim tab: the money, then the documents, then the fields. */
function DemoClaimBody({ demoCase, stage }) {
  const claim = demoCase.claim;
  const costs = claim.costs ?? {};
  const amounts = [
    ['Estimated', costs.estimatedUSD], ['Approved', costs.approvedUSD],
    ['Claimed', costs.claimedUSD], ['Recovered', costs.recoveredUSD],
  ];
  return (
    <DemoStageBody stage={stage} label="Claim">
      <Panel title="Amounts">
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: 1 }}>
          {amounts.map(([label, value]) => (
            <Box key={label} sx={{ p: 1, borderRadius: 1, border: 1, borderColor: 'divider' }}>
              <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 10 }}>{label}</Typography>
              <Typography sx={{ fontSize: 16, fontWeight: 700,
                color: value == null ? 'text.disabled' : 'text.primary' }}>
                {value == null ? 'Not recorded' : money(value)}
              </Typography>
            </Box>
          ))}
        </Box>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1, lineHeight: 1.5 }}>
          {claim.costBasis}
        </Typography>
      </Panel>
      <Panel title="Claim record">
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 1.25 }}>
          <Field label="Claim reference" value={claim.claimReference}
            absent="No claim has been raised" />
          <Field label="Submitted" value={dateTime(claim.submittedAt)} absent="Not submitted" />
          <Field label="Prepared by" value={claim.preparedBy} absent="No claims officer assigned" />
          <Field label="Insurer decision"
            value={claim.insurerDecision
              ? `${claim.insurerDecision.outcome} — ${claim.insurerDecision.insurer}` : null}
            absent="No insurer has seen this claim" />
        </Box>
        {claim.insurerDecision?.note && (
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1, lineHeight: 1.5 }}>
            {claim.insurerDecision.note}
          </Typography>
        )}
        {!claim.insurerDecision && claim.submittedAt && (
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1, lineHeight: 1.5 }}>
            This claim failed ACS's own pre-submission validation. Nothing here is an insurer's
            decision: no insurer has received it.
          </Typography>
        )}
      </Panel>
    </DemoStageBody>
  );
}

/**
 * The audit trail, oldest first — the order the work happened in.
 *
 * Two logs, kept apart on purpose. The case's own trail is the narrative's history. The recovery
 * log is what THIS session did: every system queried, every match proposed, every decision taken
 * and every validation change that followed. Merging them would make a demonstration's actions
 * look like part of the record.
 */
function DemoAuditBody({ demoCase, recoveryAudit = null }) {
  const recoveryEntries = recoveryAudit?.forCase(demoCase.demoCaseId) ?? [];
  return (
    <Stack spacing={1.5}>
    {Boolean(recoveryEntries.length) && (
      <Panel title={`Evidence recovery log, this session (${recoveryEntries.length} entries)`}>
        <Stack spacing={0}>
          {recoveryEntries.map(entry => (
            <Stack key={entry.sequence} direction="row" spacing={1.25}
              sx={{ alignItems: 'flex-start', py: 0.7, borderBottom: 1, borderColor: 'divider',
                '&:last-of-type': { borderBottom: 0 } }}>
              <Box sx={{ width: 118, flex: 'none' }}>
                <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 10 }}>
                  {entry.event.replace(/_/g, ' ')}
                </Typography>
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontSize: 11.5, lineHeight: 1.5 }}>{entry.detail}</Typography>
                <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 10 }}>
                  {entry.actor}
                </Typography>
              </Box>
            </Stack>
          ))}
        </Stack>
      </Panel>
    )}
    <Panel title={`Audit trail (${demoCase.auditTrail.length} entries)`}>
      <Stack spacing={0}>
        {demoCase.auditTrail.map((entry, index) => (
          <Stack key={`${entry.at}-${index}`} direction="row" spacing={1.25}
            sx={{ alignItems: 'flex-start', py: 0.85, borderBottom: 1, borderColor: 'divider',
              '&:last-of-type': { borderBottom: 0 } }}>
            <Box sx={{ width: 128, flex: 'none' }}>
              <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 10.5 }}>
                {dateTime(entry.at)}
              </Typography>
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.4 }}>
                <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{entry.event}</Typography>
                {entry.role && <Pill tone="text.secondary">{entry.role.replace(/_/g, ' ')}</Pill>}
              </Stack>
              <Typography sx={{ fontSize: 11.5, lineHeight: 1.5 }}>{entry.detail}</Typography>
              <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: 10.5 }}>
                {entry.actor}
              </Typography>
            </Box>
          </Stack>
        ))}
      </Stack>
    </Panel>
    </Stack>
  );
}

/** The demo case's Overview tab. */
function DemoOverviewBody({ demoCase, evaluation }) {
  const location = evaluation.location;
  return (
    <Stack spacing={1.5}>
      <Panel title="Incident">
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 1.25 }}>
          <Field label="Type" value={demoCase.incident.incidentType} />
          <Field label="Reported" value={dateTime(demoCase.incident.reportedAt)} />
          <Field label="Severity" value={demoCase.incident.severity} />
          <Field label="Roadway" value={location.roadway} />
          <Field label="Direction" value={location.direction}
            absent="Not recorded on the source incident" />
          <Field label="Segment" value={location.segmentId} absent="Not recorded" />
          <Field label="Milepost" value={location.milepost}
            absent="The register publishes none" />
          <Field label="Source incident" value={location.sourceIncidentId}
            absent="No incident with coordinates was available" />
        </Box>
        <Typography variant="body2" sx={{ fontSize: 12, lineHeight: 1.6, mt: 1 }}>
          {demoCase.incident.description}
        </Typography>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.75, lineHeight: 1.5 }}>
          {location.note}
        </Typography>
      </Panel>

      <Panel title="Affected asset">
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 1.25 }}>
          <Field label="Asset" value={demoCase.asset.assetName} />
          <Field label="Asset id" value={demoCase.asset.assetId} />
          <Field label="Type" value={demoCase.asset.assetType} />
          <Field label="Subtype" value={demoCase.asset.assetSubtype} absent="Not applicable to this asset" />
        </Box>
      </Panel>

      <Panel title="Lifecycle">
        <DemoStageStrip evaluation={evaluation} />
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1, lineHeight: 1.5 }}>
          Every state above was derived from the case's field data by the shared validation engine.
          A stage passes only when all of its mandatory checks are satisfied, and never because it
          holds no records.
        </Typography>
      </Panel>

      <Panel title="Ownership and next step">
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 1.25 }}>
          <Field label="Current stage" value={STAGE_LABELS[demoCase.workflow.currentStage] ?? demoCase.workflow.currentStage} />
          <Field label="Overall status" value={evaluation.presentation.label} />
          <Field label="Responsible role" value={demoCase.workflow.assignedRole?.replace(/_/g, ' ')}
            absent="Nothing outstanding" />
          <Field label="Responsible team" value={demoCase.workflow.assignedTeam} absent="Nothing outstanding" />
        </Box>
        <Typography sx={{ fontSize: 12.5, lineHeight: 1.6, mt: 1 }}>
          <strong>Next required action:</strong> {evaluation.nextAction.text}
        </Typography>
      </Panel>

      <DemoExplanation explanation={evaluation.explanation} />
    </Stack>
  );
}


/**
 * The case dialog, in either of its two modes.
 *
 * `acsCase` is a real ACS repair-form task attached to a maintenance record. `demoCase` is one of
 * the synthetic demo-case records, which carry a complete lifecycle. One dialog serves both: the
 * shell, the section rail, the field renderers and the QC/QA review are shared, and only the
 * section list and the bodies differ. A second popup for the demo cases would be a second thing to
 * keep in step with this one.
 */
export function AcsCaseDialog({ open, onClose, acsCase = null, incident = null, review = null,
  reviewLoading = false, demoCase: demoRecord = null }) {
  const demo = demoRecord?.demoCase ?? null;
  const evaluation = demoRecord?.evaluation ?? null;
  const sections = demo ? DEMO_SECTIONS : SECTIONS;
  const firstSection = demo ? 'overview' : 'inspection';
  const [section, setSection] = useState(firstSection);
  // Both run only while their own tab is open: a four-system search and a weather request for a
  // case nobody has asked about would be work the operator never sees.
  const recovery = useEvidenceRecovery(demoRecord, open && section === 'evidence');
  const context = useIncidentContext(demoRecord, open && section === 'context');
  // A new case opens on its first section, not on whatever the last one was left on.
  useEffect(() => { if (open) setSection(firstSection); },
    [open, acsCase?.caseId, demo?.demoCaseId, firstSection]);

  const task = acsCase?.task ?? null;
  const illustrative = !demo && acsCase?.evidence === CASE_EVIDENCE.ILLUSTRATIVE;
  if (!demo && (!acsCase || !task)) return null;

  const demoBody = () => {
    switch (section) {
      case 'inspection':
        return <DemoStageBody stage={evaluation.stages.INSPECTION} label="Inspection" />;
      case 'repair':
        return <DemoStageBody stage={evaluation.stages.REPAIR} label="Repair" />;
      case 'qc':
        return <DemoQcBody demoCase={demo} evaluation={evaluation} />;
      case 'claim':
        return <DemoClaimBody demoCase={demo} stage={evaluation.stages.CLAIM} />;
      case 'evidence':
        return (
          <EvidenceRecoveryTab
            recovery={recovery.recovery} loading={recovery.loading}
            decisions={recovery.decisions} onDecide={recovery.decide}
            onApply={recovery.apply} applied={recovery.applied}
            outcome={demo.evidenceRecovery?.outcome ?? null}
            packageOutcome={demo.evidenceRecovery?.packageOutcome ?? null} />
        );
      case 'context':
        return <IncidentContextTab context={context.context} loading={context.loading} />;
      case 'audit':
        return <DemoAuditBody demoCase={demo} recoveryAudit={recovery.audit} />;
      default:
        return <DemoOverviewBody demoCase={demo} evaluation={evaluation} />;
    }
  };

  const body = () => {
    switch (section) {
      case 'inspection':
        return <StageBody stage={stageOf(task, 'INSPECTION')} kind="Inspection" task={task}
          absentFields={acsCase.absentFields} />;
      case 'repair':
        return <RepairSection task={task} record={incident} absentFields={acsCase.absentFields} />;
      case 'qc':
        return (
          <Stack spacing={1.5}>
            <QcQaSection review={review} loading={reviewLoading} />
            <QcSection task={task} />
          </Stack>
        );
      case 'claims':
        return <ClaimsSection task={task} />;
      case 'assets':
        return (
          <Panel title="Related assets">
            {task.latitude ? (
              <>
                <Field label="Coordinates from the form"
                  value={`${task.latitude.toFixed(6)}, ${task.longitude.toFixed(6)}`} />
                <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1, lineHeight: 1.5 }}>
                  Typed into the form's location field. The asset this task repaired is not named
                  on the form, so it can only be inferred from these coordinates — close enough to
                  identify, but ACS has not confirmed it.
                </Typography>
              </>
            ) : (
              <Typography sx={{ fontSize: 12, color: 'warning.main', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <WarningAmberOutlinedIcon sx={{ fontSize: 14 }} />
                This task has no coordinates — only the text “{task.siteLocationText}” — and names no
                asset id, so it cannot be tied to an asset.
              </Typography>
            )}
          </Panel>
        );
      default:
        return (
          <Stack spacing={1.5}>
            <Panel title="Task">
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: 1.25 }}>
                <Field label="Task No." value={task.taskNumber} />
                <Field label="Filed" value={dateLabel(task.date)} />
                <Field label="Direction" value={task.laneDirection} />
                <Field label="State road" value={task.stateRoad ? `SR ${task.stateRoad}` : null} />
                <Field label="Responded" value={task.respondedBy?.join(', ') || null} />
                <Field label="Event #" value={task.eventNumber} />
              </Box>
              <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
                Location as entered: “{task.siteLocationText ?? 'not stated'}”
              </Typography>
            </Panel>
            <Panel title="Stages filed">
              <Stack spacing={0.75}>
                {acsCase.stages.map((stage, index) => (
                  <Stack key={`${stage.stage}-${index}`} direction="row" spacing={1} alignItems="baseline">
                    <Chip size="small" label={stage.stageLabel} sx={{ height: 20, fontSize: 10.5 }} />
                    <Typography variant="caption" color="text.secondary">
                      {dateLabel(stage.date) ?? 'no date'}{stage.inspector ? ` · ${stage.inspector}` : ''}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            </Panel>
            <DataCheck findings={acsCase.findings} />
          </Stack>
        );
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth
      aria-labelledby="acs-case-title"
      slotProps={{ paper: { sx: {
        backgroundImage: 'none', maxHeight: '86vh',
        // The close button is anchored to this, not to the heading row, so it sits in the
        // dialog's own top-right corner however long the case title and subtitle run.
        position: 'relative',
      } } }}>
      <IconButton size="small" onClick={onClose} aria-label="Close the ACS case"
        sx={{ position: 'absolute', top: 8, right: 8, zIndex: 2 }}>
        <CloseIcon fontSize="small" />
      </IconButton>
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between"
        sx={{ px: 2, pt: 1.75, pb: 1.25, pr: 6 }}>
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.25 }}>
            <Typography variant="caption" color="text.secondary">ACS case</Typography>
            {demo && (
              <Chip size="small" color="secondary" variant="outlined" label={demo.demoLabel}
                sx={{ height: 19, fontSize: 10, fontWeight: 700 }} />
            )}
            {illustrative && (
              <Chip size="small" color="warning" variant="outlined" label="Illustrative link"
                sx={{ height: 19, fontSize: 10, fontWeight: 700 }} />
            )}
          </Stack>
          <Typography id="acs-case-title" sx={{ fontSize: 19, fontWeight: 700, lineHeight: 1.15 }}>
            {demo ? demo.demoCaseId : acsCase.caseId}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 12 }}>
            {demo
              ? `${demo.incident.incidentType} · ${demo.asset.assetName}`
                + `${evaluation.location.sourceIncidentId ? ` · at incident ${evaluation.location.sourceIncidentId}` : ''}`
              : `Task ${task.taskNumber} · ${task.siteLocationText ?? 'location not stated'}`
                + `${incident?.id ? ` · opened from ${incident.id}` : ''}`}
          </Typography>
        </Box>
      </Stack>

      {illustrative && (
        <Box sx={{
          mx: 2, mb: 1.25, px: 1.25, py: 1, borderRadius: 1.5,
          border: 1, borderColor: 'warning.main',
          bgcolor: theme => `${theme.palette.warning.main}14`,
        }}>
          <Typography variant="body2" sx={{ fontSize: 11.5, lineHeight: 1.5 }}>
            {acsCase.evidenceNote}
          </Typography>
        </Box>
      )}

      <Divider />

      <DialogContent sx={{ p: 0, display: 'flex', minHeight: 0 }}>
        <Box component="nav" aria-label="Case sections" sx={{
          width: 168, flexShrink: 0, borderRight: 1, borderColor: 'divider', p: 1,
          display: { xs: 'none', sm: 'block' },
        }}>
          <Stack spacing={0.25}>
            {sections.map(({ id, label, Icon }) => (
              <Button key={id} onClick={() => setSection(id)} size="small"
                startIcon={<Icon sx={{ fontSize: 16 }} />}
                aria-current={section === id ? 'true' : undefined}
                sx={{
                  justifyContent: 'flex-start', textTransform: 'none', fontSize: 12.5,
                  color: section === id ? 'primary.main' : 'text.secondary',
                  bgcolor: section === id ? 'action.selected' : 'transparent',
                  fontWeight: section === id ? 700 : 500,
                }}>
                {label}
              </Button>
            ))}
          </Stack>
        </Box>
        <Box sx={{ flex: 1, minWidth: 0, p: 2, overflowY: 'auto' }}>
          {/* The section list collapses to a scrolling row on a narrow dialog. */}
          <Stack direction="row" spacing={0.5} sx={{ display: { sm: 'none' }, mb: 1.5, overflowX: 'auto' }}>
            {sections.map(({ id, label }) => (
              <Chip key={id} size="small" label={label} onClick={() => setSection(id)}
                color={section === id ? 'primary' : 'default'}
                variant={section === id ? 'filled' : 'outlined'} />
            ))}
          </Stack>
          {demo ? demoBody() : body()}
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 2, lineHeight: 1.5 }}>
            {demo
              ? 'Source: data/acs-demo-cases.json — synthetic demonstration records. Statuses are '
                + 'derived by the shared QC/QA validation engine, not read from the file.'
              : `Source: ACS General Accident and Repair Form. ${acsCase.sourceNote}`}
          </Typography>
        </Box>
      </DialogContent>
    </Dialog>
  );
}
