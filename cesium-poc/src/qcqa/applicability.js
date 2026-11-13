/**
 * Which checklist applies, and why.
 *
 * Selection is driven by the ASSET and the WORK, never by the incident type alone: a vehicle
 * collision tells you nothing about whether a guardrail, an attenuator or a light pole was
 * repaired, and picking a checklist from it would be a guess dressed as a rule.
 *
 * Every selection carries its reason, its confidence and the fields it was made from, so a
 * reviewer can see what the engine used and overrule it.
 */
import { CONFIDENCE, TEMPLATE_SCOPE } from './schema.js';
import { TEMPLATES, templateById } from './templateCatalog.js';

/**
 * The corridor's own asset vocabulary, mapped onto the templates' terms.
 *
 * The left-hand side is what the DataConnect classes actually contain, misspellings included
 * ("Attenuetors" is the register's spelling, not a typo here).
 */
export const ASSET_TYPE_SYNONYMS = Object.freeze({
  attenuetors: 'attenuator',
  attenuators: 'attenuator',
  attenuator: 'attenuator',
  'crash attenuator': 'attenuator',
  guardrail: 'guardrail',
  'guard rail': 'guardrail',
  fence: 'fence',
  bridges: 'bridges',
  bridge: 'bridges',
  'sign structures': 'sign structures',
  'sign structure': 'sign structures',
  lighting: 'lighting',
  'lighting - street light': 'lighting - street light',
  'lighting - under deck': 'lighting - under deck',
  'lighting - nav. lights': 'lighting - nav. lights',
  'lighting - load center': 'lighting - load center',
  'lighting - sign structure': 'lighting - sign structure',
  landscape: 'landscape',
  drainage: 'drainage',
  'communication hub': 'communication hub',
  delineators: 'delineator',
  'pavement marking': 'pavement marking',
  'raised pavement marker': 'raised pavement marker',
  concrete: 'concrete',
  sidewalk: 'sidewalk',
  roadway: 'roadway',
});

/** The corridor's Work Type vocabulary, mapped onto the templates' activities. */
export const WORK_ACTIVITY_SYNONYMS = Object.freeze({
  'corrective repair': 'repair',
  repair: 'repair',
  'parts replacement': 'replacement',
  replacement: 'replacement',
  'asset reset': 'reset',
  reset: 'reset',
  'field restoration': 'repair',
  'preventive maintenance': 'preventive maintenance',
  'routine maintenance': 'routine maintenance',
  maintenance: 'maintenance',
  inspection: 'inspection',
  'root cause investigation': 'inspection',
  'corridor mitigation': 'maintenance',
  installation: 'installation',
  mowing: 'mowing',
  sweeping: 'sweeping',
  'graffiti removal': 'graffiti removal',
  'service patrol': 'service patrol',
  patrol: 'service patrol',
});

const norm = value => String(value ?? '').trim().toLowerCase();
export const normaliseAssetType = value => ASSET_TYPE_SYNONYMS[norm(value)] ?? (value ? norm(value) : null);
export const normaliseWorkActivity = value => WORK_ACTIVITY_SYNONYMS[norm(value)] ?? (value ? norm(value) : null);

/** Does this template cover this asset type and this activity? */
function matches(template, { assetType, assetSubtype, workActivity }) {
  const assetTypes = (template.applicability.assetTypes ?? []).map(norm);
  const activities = (template.applicability.workActivities ?? []).map(norm);
  const subtypes = (template.applicability.assetSubtypes ?? []).map(norm);

  const assetHit = assetTypes.length > 0 && assetType ? assetTypes.includes(norm(assetType)) : false;
  const activityHit = activities.length > 0 && workActivity
    ? activities.includes(norm(workActivity)) : false;
  const subtypeHit = subtypes.length > 0 && assetSubtype ? subtypes.includes(norm(assetSubtype)) : false;

  return { assetHit, activityHit, subtypeHit, hasAssetScope: assetTypes.length > 0 };
}

/**
 * Select the templates for one piece of work.
 *
 * @param {{incidentType?: string, assetType?: string, assetSubtype?: string,
 *          workActivity?: string, workOrderId?: string}} context
 */
export function selectTemplates(context = {}) {
  const assetType = normaliseAssetType(context.assetType);
  const assetSubtype = context.assetSubtype ?? null;
  const workActivity = normaliseWorkActivity(context.workActivity);

  // Rule 5: without an asset type or an activity the classification is unresolved. It is not a
  // licence to fall back to the generic form.
  if (!assetType || !workActivity) {
    return Object.freeze({
      selectedTemplates: Object.freeze([]),
      universalTemplates: Object.freeze(universal().map(template => template.templateId)),
      selectionReason: !assetType && !workActivity
        ? 'Neither an asset type nor a work activity is recorded, so no checklist can be chosen.'
        : !assetType
          ? `Work activity "${context.workActivity}" is recorded but the asset type is not, and the asset decides the checklist.`
          : `Asset type "${context.assetType}" is recorded but the work activity is not.`,
      confidence: CONFIDENCE.UNRESOLVED,
      requiresConfirmation: true,
      unresolved: true,
      basis: Object.freeze({ assetType, assetSubtype, workActivity,
        incidentType: context.incidentType ?? null, workOrderId: context.workOrderId ?? null }),
      candidates: Object.freeze([]),
    });
  }

  const scored = TEMPLATES
    .filter(template => template.scope === TEMPLATE_SCOPE.ASSET_SPECIFIC)
    .map(template => ({ template, ...matches(template, { assetType, assetSubtype, workActivity }) }))
    .filter(entry => entry.assetHit && entry.activityHit);

  // Rule 3: a subtype match is a better answer than a type match.
  const exact = scored.filter(entry => entry.subtypeHit);
  const chosen = exact.length ? exact : scored;

  if (!chosen.length) {
    const generic = TEMPLATES.find(template => template.isGenericFallback) ?? null;
    return Object.freeze({
      selectedTemplates: Object.freeze([]),
      // Rule 6: the generic form is offered, never applied as though it were a match.
      suggestedGeneric: generic?.templateId ?? null,
      universalTemplates: Object.freeze(universal().map(template => template.templateId)),
      selectionReason: `No ACS checklist covers ${assetType} with activity "${workActivity}". `
        + (generic ? `${generic.templateId} (${generic.title}) is the generic form; a reviewer must `
          + 'confirm it rather than it being applied automatically.' : ''),
      confidence: CONFIDENCE.UNRESOLVED,
      requiresConfirmation: true,
      unresolved: true,
      basis: Object.freeze({ assetType, assetSubtype, workActivity,
        incidentType: context.incidentType ?? null, workOrderId: context.workOrderId ?? null }),
      candidates: Object.freeze([]),
    });
  }

  const confidence = exact.length ? CONFIDENCE.HIGH
    : chosen.length === 1 ? CONFIDENCE.HIGH : CONFIDENCE.MEDIUM;

  const names = chosen.map(entry => entry.template.templateId).join(', ');
  const reason = exact.length
    ? `${assetType} ${workActivity} on a ${assetSubtype} system — ${names} covers that model.`
    : chosen.length === 1
      ? `${assetType} ${workActivity} — ${names} is the only ACS checklist covering it.`
      : `${assetType} ${workActivity} is covered by more than one checklist (${names}); a reviewer `
        + 'should confirm which applies, or whether both do.';

  return Object.freeze({
    selectedTemplates: Object.freeze(chosen.map(entry => entry.template.templateId)),
    universalTemplates: Object.freeze(universal().map(template => template.templateId)),
    selectionReason: reason,
    confidence,
    requiresConfirmation: confidence !== CONFIDENCE.HIGH,
    unresolved: false,
    basis: Object.freeze({ assetType, assetSubtype, workActivity,
      incidentType: context.incidentType ?? null, workOrderId: context.workOrderId ?? null }),
    candidates: Object.freeze(chosen.map(entry => Object.freeze({
      templateId: entry.template.templateId,
      title: entry.template.title,
      matchedOn: Object.freeze([
        entry.assetHit ? 'assetType' : null,
        entry.activityHit ? 'workActivity' : null,
        entry.subtypeHit ? 'assetSubtype' : null,
      ].filter(Boolean)),
    }))),
  });
}

/** The crew and paperwork checklists, which apply to any job. */
export function universal() {
  return TEMPLATES.filter(template => template.scope === TEMPLATE_SCOPE.UNIVERSAL
    && !template.isGenericFallback);
}

/**
 * Several damaged assets means several checklists.
 *
 * @param {Array<object>} items one entry per damaged asset / activity pair
 */
export function selectForAssets(items = []) {
  const perAsset = items.map(item => Object.freeze({ input: item, selection: selectTemplates(item) }));
  const ids = new Set();
  for (const entry of perAsset) for (const id of entry.selection.selectedTemplates) ids.add(id);
  return Object.freeze({
    perAsset: Object.freeze(perAsset),
    selectedTemplates: Object.freeze([...ids]),
    templates: Object.freeze([...ids].map(templateById)),
    unresolvedCount: perAsset.filter(entry => entry.selection.unresolved).length,
  });
}

/** Whether a conditional section applies to this context. Unknown is not the same as no. */
export function sectionApplies(section, context = {}) {
  const rule = section.applicabilityRule;
  if (!rule) return { applies: true, reason: 'The section is unconditional.' };

  if (rule.assetSubtype) {
    if (!context.assetSubtype) {
      return { applies: null,
        reason: `The section covers ${rule.assetSubtype} and no asset subtype is recorded, so `
          + 'whether it applies cannot be determined.' };
    }
    const hit = norm(rule.assetSubtype) === norm(context.assetSubtype);
    return { applies: hit,
      reason: hit ? `The asset is a ${context.assetSubtype}.`
        : `The section covers ${rule.assetSubtype}; this asset is a ${context.assetSubtype}.` };
  }
  if (rule.assetType) {
    const wanted = [rule.assetType].flat().map(norm);
    if (!context.assetType) return { applies: null, reason: 'No asset type is recorded.' };
    const hit = wanted.includes(norm(normaliseAssetType(context.assetType)));
    return { applies: hit,
      reason: hit ? `The asset is ${context.assetType}.`
        : `The section covers ${wanted.join(' or ')}; this asset is ${context.assetType}.` };
  }
  if (rule.workActivity) {
    const wanted = [rule.workActivity].flat().map(norm);
    if (!context.workActivity) return { applies: null, reason: 'No work activity is recorded.' };
    const hit = wanted.includes(norm(normaliseWorkActivity(context.workActivity)));
    return { applies: hit,
      reason: hit ? `The activity is ${context.workActivity}.`
        : `The section covers ${wanted.join(' or ')}; this activity is ${context.workActivity}.` };
  }
  return { applies: true, reason: 'The section is unconditional.' };
}
