/**
 * One call from the UI to a validated case.
 *
 * The screen does not know about templates, adapters or rules — it asks for a review and renders
 * what comes back.
 */
import { buildCase } from './canonicalCase.js';
import { validateCase } from './validationEngine.js';
import { selectTemplates } from './applicability.js';

/**
 * Review one maintenance record.
 *
 * @param {object} record the selected incident / work order / inspection / ticket
 * @param {{provider: object, acsCase?: object|null, templateIds?: string[]|null}} deps
 */
export async function reviewRecord(record, { provider, acsCase = null, templateIds = null } = {}) {
  if (!record || !provider) return null;
  const id = record.id ?? null;

  const [inspection, workOrders, approvals, qcResponses, evidence] = await Promise.all([
    provider.getInspection(id).catch(() => null),
    provider.getWorkOrders(id).catch(() => []),
    provider.getApprovals(id).catch(() => ({ qc: null, qa: null })),
    provider.getQCResponses(id).catch(() => null),
    provider.getEvidence(id).catch(() => []),
  ]);

  // The record itself may be the work order, the inspection or the incident.
  const isWorkOrder = Boolean(record.raw?.attributes?.['Work Order ID']);
  const isInspection = Boolean(record.raw?.attributes?.inspection_form_family);

  const canonical = buildCase({
    caseId: acsCase?.caseId ?? id,
    incident: isWorkOrder || isInspection ? null : record,
    workOrder: isWorkOrder ? record : workOrders[0] ?? null,
    inspection: isInspection ? record : inspection,
    assetIndex: provider.assetIndex?.() ?? null,
    acsCase,
    qcResponses,
    approvals,
    evidence,
  });

  const result = validateCase(canonical, { templateIds });
  return Object.freeze({ canonical, result, provider: provider.name ?? 'unknown' });
}

/** The selection alone, for showing which checklist applies before anything is evaluated. */
export function previewSelection(canonicalCase) {
  return selectTemplates(canonicalCase?.classification ?? {});
}
