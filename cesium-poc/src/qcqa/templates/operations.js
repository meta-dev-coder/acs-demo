/** Routine-operations checklists, extracted verbatim from the ACS PDFs. */
import { POLARITY, RESPONSE_TYPES, TEMPLATE_SCOPE, VALIDATION_TYPES } from '../schema.js';
import { QC_QA_APPROVALS, STANDARD_HEADER } from './roadside.js';

const { YES_NO, YES_NO_NA, TEXT } = RESPONSE_TYPES;
const q = (id, text, page, extra = {}) => Object.freeze({
  id, text, sourcePage: page, responseType: YES_NO, polarity: POLARITY.YES_IS_PASS,
  required: true, validationType: VALIDATION_TYPES.CHECKLIST_RESPONSE,
  sourceField: null, evidenceRequirements: [], ...extra,
});
const na = (id, text, page, extra = {}) => q(id, text, page, { responseType: YES_NO_NA, ...extra });

export const GRAFFITI_540_1 = Object.freeze({
  templateId: 'ACS-540.1',
  title: 'Graffiti Removal QC/QA',
  version: '1.0',
  scope: TEMPLATE_SCOPE.ASSET_SPECIFIC,
  source: { file: '540.1 Graffiti Removal  QC_QA.pdf', page: 1 },
  header: STANDARD_HEADER,
  applicability: {
    assetTypes: ['bridges', 'sign structures', 'structure', 'wall'],
    workActivities: ['graffiti removal', 'maintenance'],
    incidentTypes: [],
  },
  approvals: QC_QA_APPROVALS,
  sections: [{
    id: 'graffiti',
    title: 'Graffiti Removal QC/QA Checklist',
    questions: [
      q('ACS-540.1-Q01', 'Has the graffiti been completely removed as per the work order?', 1),
      q('ACS-540.1-Q02', 'Is there additional graffiti removal required in the surrounding area, and has it been removed?', 1),
      q('ACS-540.1-Q03', 'Is the covering material color-coordinated with the surrounding structure? Is the texture similar?', 1),
      q('ACS-540.1-Q04', 'Is the removal product used on FDOT\'s Qualified Products List (QPL)?', 1,
        { referencedStandard: 'FDOT Qualified Products List (QPL)' }),
      // The only question on this form where YES is the defect.
      q('ACS-540.1-Q05', 'Are remnants of graffiti visible through the covering material used?', 1,
        { polarity: POLARITY.NO_IS_PASS }),
    ],
  }],
});

export const SWEEPING_543_1 = Object.freeze({
  templateId: 'ACS-543.1',
  title: 'Road Sweeping (Mechanical) QC/QA',
  version: '1.0',
  scope: TEMPLATE_SCOPE.ASSET_SPECIFIC,
  source: { file: '543.1 Road Sweeping (Mechanical) QC_QA.pdf', page: 1 },
  header: STANDARD_HEADER,
  applicability: {
    assetTypes: ['roadway', 'bridges'],
    workActivities: ['sweeping', 'maintenance'],
    incidentTypes: [],
  },
  approvals: QC_QA_APPROVALS,
  sections: [{
    id: 'sweeping',
    title: 'Roadway & Bridge Sweeping QC/QA Checklist',
    questions: [
      na('ACS-543.1-Q01', 'Is all sweeping work performed in accordance with FDOT\'s Special Provisions ME110-31.3?', 1,
        { referencedStandard: 'FDOT Special Provisions ME110-31.3' }),
      na('ACS-543.1-Q02', 'Is excess dust controlled throughout the operation with a proper spray system?', 1),
      na('ACS-543.1-Q03', 'Is excess debris passed over by the sweeper removed by other methods?', 1),
      na('ACS-543.1-Q04', 'Was the correct safety criteria implemented during the period of work?', 1),
      na('ACS-543.1-Q05', 'Is all removal and disposal of debris in accordance with Federal, State, and local rules and regulations?', 1),
    ],
  }],
});

export const SERVICE_PATROL_995_1 = Object.freeze({
  templateId: 'ACS-995.1',
  title: 'Service Patrol Checklist QC/QA',
  version: '1.0',
  scope: TEMPLATE_SCOPE.UNIVERSAL,
  source: { file: '995.1 Service Patrol Checklist  QC_QA.pdf', page: 1 },
  /** This form's header has no Name field; it goes straight from SR to WO No. */
  header: STANDARD_HEADER.filter(field => field.field !== 'name'),
  applicability: { assetTypes: [], workActivities: ['service patrol', 'patrol'], incidentTypes: [] },
  approvals: QC_QA_APPROVALS,
  sections: [
    {
      id: 'gps',
      title: 'GPS SYSTEM REVIEW QC/QA Checklist',
      questions: [
        q('ACS-995.1-Q01', 'Are routes being patrolled according to schedule?', 1),
        q('ACS-995.1-Q02', 'Were the stop times reasonable?', 1),
      ],
    },
    {
      id: 'field',
      title: 'Field Review',
      questions: [
        q('ACS-995.1-Q03', 'Did the patrol maintain adequate safety precautions during route?', 1),
        q('ACS-995.1-Q04', 'If securing an area, were the appropriate safety device used?', 1,
          { conditional: 'If securing an area' }),
        q('ACS-995.1-Q05', 'Were debris, dead animals and small obstructions removed from the roadway?', 1),
      ],
    },
    {
      id: 'reporting',
      title: 'Reporting QC/QA Checklist',
      questions: [
        q('ACS-995.1-Q06', 'Was the work order filled out properly, including but not limited to dates, accomplishments, activities, labor, equipment and materials used, etc?', 1,
          { evidenceRequirements: ['Work order with labor, equipment and materials'] }),
        q('ACS-995.1-Q07', 'Was a maintenance needs report prepared for deficiencies identified during the patrol?', 1,
          { evidenceRequirements: ['Maintenance needs report'] }),
        q('ACS-995.1-Q08', 'Was an AR written for assets damaged due to vehicular traffic?', 1,
          { evidenceRequirements: ['Accident Report (AR)'] }),
        q('ACS-995.1-Q09', 'If GPS available, was it reported on the AR?', 1,
          { conditional: 'If GPS available' }),
        q('ACS-995.1-Q10', 'Were required photos attached to the paperwork for maintenance needs?', 1,
          { evidenceRequirements: ['Photos attached to maintenance needs paperwork'] }),
      ],
    },
  ],
});

export const MISC_ROUTINE_996 = Object.freeze({
  templateId: 'ACS-996',
  title: 'Misc. Routine Maintenance QC/QA',
  version: '1.0',
  scope: TEMPLATE_SCOPE.UNIVERSAL,
  source: { file: '996 Misc. Routine Maintenance QC_QA.pdf', page: 1 },
  header: STANDARD_HEADER,
  /** The generic form. Selected only when nothing asset-specific fits, and never silently. */
  isGenericFallback: true,
  applicability: { assetTypes: [], workActivities: ['maintenance', 'routine maintenance'], incidentTypes: [] },
  approvals: QC_QA_APPROVALS,
  sections: [
    {
      id: 'description',
      title: 'Work completed',
      questions: [
        Object.freeze({
          id: 'ACS-996-Q00',
          text: 'Please provide a brief description of the work completed for this task and subject to QC review:',
          responseType: TEXT, polarity: POLARITY.INFORMATIONAL, required: true,
          validationType: VALIDATION_TYPES.REQUIRED_FIELD, sourcePage: 1,
          sourceField: null, evidenceRequirements: [],
        }),
      ],
    },
    {
      id: 'general',
      title: 'General QC/QA Checklist',
      questions: [
        na('ACS-996-Q01', 'Were all corrective actions from the original report completed?', 1),
        na('ACS-996-Q02', 'Is the area free of debris, trash, and leftover materials?', 1),
        na('ACS-996-Q03', 'Was vegetation properly removed or controlled, if applicable?', 1,
          { conditional: 'If applicable' }),
        na('ACS-996-Q04', 'Were all reported safety hazards corrected?', 1),
        na('ACS-996-Q05', 'Does the final visual appearance meet project presentation standards?', 1),
        na('ACS-996-Q06', 'Was the work completed within the expected timeframe and response period?', 1),
      ],
    },
  ],
});

export const MOWING = Object.freeze({
  templateId: 'ACS-MOWING',
  title: 'Large, Intermediate/Small, Slope, and Hand Mowing QC/QA',
  version: '1.0',
  scope: TEMPLATE_SCOPE.ASSET_SPECIFIC,
  source: { file: 'Large, Intermediate, Small, Slope, and Hand Mowing QC_QA.pdf', page: 1 },
  header: STANDARD_HEADER,
  applicability: { assetTypes: ['landscape'], workActivities: ['mowing', 'maintenance'], incidentTypes: [] },
  approvals: QC_QA_APPROVALS,
  sections: [{
    id: 'mowing',
    title: 'Large, Intermediate/Small, Slope, and Hand Mowing QC/QA Checklist',
    questions: [
      na('ACS-MOWING-Q01', 'Has mowing been carried out according to the maintenance schedule?', 1),
      na('ACS-MOWING-Q02', 'Has all work been performed in accordance with the FDOT Standard Maintenance Special Provisions ME104-40 and FDOT\'s "Guide to Roadside Mowing"?', 1,
        { referencedStandard: 'FDOT Standard Maintenance Special Provisions ME104-40; Guide to Roadside Mowing' }),
      na('ACS-MOWING-Q03', 'Does all mowing equipment and vehicles meet current safety standards?', 1),
      na('ACS-MOWING-Q04', 'Is all litter removed prior to the mowing cycle so debris will not cause aesthetic and hazardous conditions?', 1),
      na('ACS-MOWING-Q05', 'Are areas overly saturated with standing water avoided to prevent damage to the turf, slope, or ditch?', 1),
      na('ACS-MOWING-Q06', 'Are all areas cut cleanly, including around appurtenances such as headwalls, inlet grates, etc.?', 1),
    ],
  }],
});

export const LANDSCAPING = Object.freeze({
  templateId: 'ACS-LANDSCAPE',
  title: 'Landscaping, Tree & Brush Removal, Herbicide Spray QC/QA',
  version: '1.0',
  scope: TEMPLATE_SCOPE.ASSET_SPECIFIC,
  source: { file: 'Landscaping, Tree & Brush Removal, Herbicide Spray QC_QA.pdf', page: 1 },
  header: STANDARD_HEADER,
  applicability: {
    assetTypes: ['landscape'],
    workActivities: ['landscaping', 'tree removal', 'brush removal', 'herbicide spray', 'maintenance'],
    incidentTypes: [],
  },
  approvals: QC_QA_APPROVALS,
  sections: [
    {
      id: 'general',
      title: 'General for all',
      questions: [
        q('ACS-LANDSCAPE-Q01', 'Are correct MOT procedures followed during the period of operation? (Note: QC, QA can only verify if on site during operations)', 1,
          { verifiabilityNote: 'QC, QA can only verify if on site during operations' }),
        q('ACS-LANDSCAPE-Q02', 'Are proper vehicle lighting and signing designation in place on each vehicle?', 1),
        q('ACS-LANDSCAPE-Q03', 'Do all equipment and vehicles meet current safety standards?', 1),
      ],
    },
    {
      id: 'landscaping',
      title: 'Landscaping',
      conditionalNote: 'If applicable, if not continue to next section',
      applicabilityRule: { workActivity: ['landscaping', 'maintenance'] },
      questions: [
        na('ACS-LANDSCAPE-Q04', 'Does all pruning and trimming meet industry standards for the specific type of vegetation?', 1),
        na('ACS-LANDSCAPE-Q05', 'Has all cut vegetation been removed from the work site and disposed of in accordance with FDOT regulations?', 1),
      ],
    },
    {
      id: 'treeBrush',
      title: 'Tree and Bush Removal',
      conditionalNote: 'If applicable, if not continue to next section',
      applicabilityRule: { workActivity: ['tree removal', 'brush removal'] },
      questions: [
        na('ACS-LANDSCAPE-Q06', 'Is all work performed in accordance with the FDOT Standard Maintenance Special Provisions ME580-40?', 1,
          { referencedStandard: 'FDOT Standard Maintenance Special Provisions ME580-40' }),
        na('ACS-LANDSCAPE-Q07', 'Is all tree and brush removal in accordance with the required clear zone?', 1),
        na('ACS-LANDSCAPE-Q08', 'Has all cut vegetation been removed from the work site and disposed of in accordance with FDOT regulations?', 1),
      ],
    },
    {
      id: 'herbicide',
      title: 'Herbicide Spray',
      conditionalNote: 'If applicable, if not NA',
      applicabilityRule: { workActivity: ['herbicide spray'] },
      questions: [
        na('ACS-LANDSCAPE-Q09', 'Is all work performed in accordance with the FDOT Standard Maintenance Special Provisions ME580-30?', 1,
          { referencedStandard: 'FDOT Standard Maintenance Special Provisions ME580-30' }),
        na('ACS-LANDSCAPE-Q10', 'Is the correct Personal Protective Equipment (PPE) utilized during operation? (Note: QC, QA can only verify if on site during operations)', 1,
          { verifiabilityNote: 'QC, QA can only verify if on site during operations' }),
        na('ACS-LANDSCAPE-Q11', 'Do all personnel applying herbicides possess a current Florida Department of Agriculture Commercial Applicator license, with supporting documentation on file at the project office?', 1,
          { evidenceRequirements: ['Commercial Applicator license documentation'] }),
        na('ACS-LANDSCAPE-Q12', 'Are the herbicides used registered with the Florida Department of Agriculture for use in the State of Florida, and administered in the appropriate concentrations?', 1),
      ],
    },
  ],
});

export const OPERATIONS_TEMPLATES = Object.freeze([
  GRAFFITI_540_1, SWEEPING_543_1, SERVICE_PATROL_995_1, MISC_ROUTINE_996, MOWING, LANDSCAPING,
]);
