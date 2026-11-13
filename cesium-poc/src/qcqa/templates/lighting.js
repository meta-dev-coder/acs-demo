/** Highway lighting checklists (787.x), extracted verbatim from the ACS PDFs. */
import { POLARITY, RESPONSE_TYPES, TEMPLATE_SCOPE, VALIDATION_TYPES } from '../schema.js';
import { QC_QA_APPROVALS, STANDARD_HEADER } from './roadside.js';

const { YES_NO, YES_NO_NA } = RESPONSE_TYPES;
const q = (id, text, page, extra = {}) => Object.freeze({
  id, text, sourcePage: page, responseType: YES_NO, polarity: POLARITY.YES_IS_PASS,
  required: true, validationType: VALIDATION_TYPES.CHECKLIST_RESPONSE,
  sourceField: null, evidenceRequirements: [], ...extra,
});
const na = (id, text, page, extra = {}) => q(id, text, page, { responseType: YES_NO_NA, ...extra });

export const LIGHTING_POLE_787_1 = Object.freeze({
  templateId: 'ACS-787.1',
  title: 'Highway Lighting Maintenance — Lighting Pole Repair QC/QA',
  version: '1.0',
  scope: TEMPLATE_SCOPE.ASSET_SPECIFIC,
  source: { file: '787.1 Highway Lighting Maintenance(Lighting Pole Reapiar)QC_QA.pdf', page: 1 },
  header: STANDARD_HEADER,
  applicability: {
    assetTypes: ['lighting', 'lighting - street light'],
    assetSubtypes: ['pole'],
    workActivities: ['repair', 'replacement', 'reset'],
    incidentTypes: [],
  },
  approvals: QC_QA_APPROVALS,
  sections: [{
    id: 'pole',
    title: 'Lighting Pole Repair QC/QA Checklist',
    questions: [
      q('ACS-787.1-Q01', 'Is the pole height, pole arm rise/run, fixture head style, and foundation consistent with the lighting poles nearest to this location?', 1),
      q('ACS-787.1-Q02', 'Are the T-base and pole access plates secure and fastened with the correct fasteners?', 1),
      q('ACS-787.1-Q03', 'Is the pole, base, and arm free of structural defects, holes, dents, or tears?', 1),
      q('ACS-787.1-Q04', 'Is the fixture lens cover closed and properly fastened?', 1),
      q('ACS-787.1-Q05', 'Is the pole mounted vertically plumb and level?', 1),
      q('ACS-787.1-Q06', 'Are the concrete foundation anchors free of any structural defects, straight, and tightly anchored into the foundation?', 1),
      q('ACS-787.1-Q07', 'Is the pole wired with the correct sized break-away fuses?', 1),
      q('ACS-787.1-Q08', 'Is the T-base anchored to the foundation with nut and split washer; is the pole anchored to the T-base with nut and split lock washer; are all connections tight?', 1),
      q('ACS-787.1-Q09', 'Does the light pole have an identification badge?', 1),
      q('ACS-787.1-Q10', 'Does the fixture burn, and is the luminescence consistent with the adjacent poles?', 1),
      q('ACS-787.1-Q11', 'Is the lighting pole grounded correctly?', 1),
      q('ACS-787.1-Q12', 'Is the work area cleaned of all debris (e.g., electrical tape, old fuses & boxes, duct tape, wire)?', 1),
    ],
  }],
});

export const LIGHTING_REPAIR_787_2 = Object.freeze({
  templateId: 'ACS-787.2',
  title: 'Highway Lighting Maintenance QC/QA — Repair',
  version: '1.0',
  scope: TEMPLATE_SCOPE.ASSET_SPECIFIC,
  source: { file: '787.2 Highway Lighting Maintenance(Repair) QC_QA.pdf', page: 1 },
  header: STANDARD_HEADER,
  applicability: {
    assetTypes: ['lighting', 'lighting - street light', 'lighting - under deck', 'lighting - nav. lights',
      'lighting - sign structure'],
    workActivities: ['repair', 'parts replacement'],
    incidentTypes: [],
  },
  approvals: QC_QA_APPROVALS,
  sections: [
    {
      id: 'highmast',
      title: 'Lighting Repair QC/QA Checklist',
      conditionalNote: 'If applicable, if not continue to next section',
      applicabilityRule: { assetSubtype: 'highmast' },
      questions: [
        na('ACS-787.2-Q01', 'Was the required repair listed on the work order completed?', 1),
        na('ACS-787.2-Q02', 'Were other repairs made? (List in comments)', 1, { polarity: POLARITY.INFORMATIONAL }),
        na('ACS-787.2-Q03', 'Is the highmast light functioning as intended?', 1),
        na('ACS-787.2-Q04', 'Were repairs made in accordance with standards and electrical codes, including FDOT and NEC specifications?', 1,
          { referencedStandard: 'FDOT and NEC specifications' }),
        na('ACS-787.2-Q05', 'Were access boxes and control boxes secured?', 1),
        na('ACS-787.2-Q06', 'Was the work area cleaned?', 1),
      ],
    },
    {
      id: 'underdeck',
      title: 'Underdeck and Navigation Lighting Repair QC/QA Checklist',
      conditionalNote: 'If applicable, if not continue to next section',
      applicabilityRule: { assetType: ['lighting - under deck', 'lighting - nav. lights'] },
      questions: [
        na('ACS-787.2-Q07', 'Was the required repair listed on the work order completed?', 1),
        na('ACS-787.2-Q08', 'Were there other repairs made at the same time?', 1, { polarity: POLARITY.INFORMATIONAL }),
        na('ACS-787.2-Q09', 'Are lights functioning as intended?', 1),
        na('ACS-787.2-Q10', 'Were repairs made according to required electrical standards/codes?', 1),
        na('ACS-787.2-Q11', 'Was the control box secured?', 1),
        na('ACS-787.2-Q12', 'Were all wiring connections properly insulated and protected against environmental conditions?', 1),
        na('ACS-787.2-Q13', 'Was the work area inspected for any potential safety hazards post-repair?', 1),
      ],
    },
    {
      id: 'signlighting',
      title: 'Sign Lighting Repair QC/QA Checklist',
      conditionalNote: 'If applicable, if not NA',
      applicabilityRule: { assetType: ['lighting - sign structure', 'sign structures'] },
      questions: [
        na('ACS-787.2-Q14', 'Was required repair listed on work order completed?', 1),
        na('ACS-787.2-Q15', 'Were other repairs made? (list in comments)', 1, { polarity: POLARITY.INFORMATIONAL }),
        na('ACS-787.2-Q16', 'Are all sign lights burning?', 1),
        // A YES here is a defect: visible damage is the thing being looked for.
        na('ACS-787.2-Q17', 'Is there visible damage to the sign light?', 1, { polarity: POLARITY.NO_IS_PASS }),
        na('ACS-787.2-Q18', 'Are at-ground connections complete and secure?', 1),
        na('ACS-787.2-Q19', 'Is the control box secure?', 1),
      ],
    },
  ],
});

export const LIGHTING_INSPECTION_787_3 = Object.freeze({
  templateId: 'ACS-787.3',
  title: 'Highway Lighting Maintenance QC/QA — Inspection',
  version: '1.0',
  scope: TEMPLATE_SCOPE.ASSET_SPECIFIC,
  source: { file: '787.3 Highway Lighting Maintenance(Inspection)QC_QA.pdf', page: 1 },
  header: STANDARD_HEADER,
  applicability: {
    assetTypes: ['lighting', 'lighting - load center', 'lighting - street light'],
    workActivities: ['inspection', 'preventive maintenance'],
    incidentTypes: [],
  },
  approvals: QC_QA_APPROVALS,
  sections: [
    {
      id: 'lightingInspection',
      title: 'Lighting Inspection QC/QA Checklist',
      conditionalNote: 'If applicable, if not continue to next section',
      questions: [
        na('ACS-787.3-Q01', 'Is lighting inspection report available and up to date?', 1,
          { evidenceRequirements: ['Lighting inspection report'] }),
        na('ACS-787.3-Q02', 'Has the lighting inspection report been completed properly? (i.e., names, dates, locations, types, pole numbers etc.)', 1),
        na('ACS-787.3-Q03', 'Is outage for period no more than 10% overall or for each type of asset?', 1,
          { threshold: { max: 10, unit: '%', measure: 'outage for period' } }),
        na('ACS-787.3-Q04', 'Is the outage count within 5%? (QA only)', 1,
          { threshold: { max: 5, unit: '%', measure: 'outage count' }, qaOnly: true }),
      ],
    },
    {
      id: 'loadCenters',
      title: 'Load Centers and Cabling Inspection QC/QA Checklist',
      conditionalNote: 'If applicable, if not NA',
      applicabilityRule: { assetType: ['lighting - load center'] },
      questions: [
        na('ACS-787.3-Q05', 'Was required repair listed on work order completed?', 1),
        na('ACS-787.3-Q06', 'Were other repairs made? (list in comments)', 1, { polarity: POLARITY.INFORMATIONAL }),
        na('ACS-787.3-Q07', 'Are lights connected to load center functioning properly?', 1),
        // Exposed or unsecured cabling is the defect, so NO is the passing answer.
        na('ACS-787.3-Q08', 'Are there any exposed or unsecured cables or wires?', 1, { polarity: POLARITY.NO_IS_PASS }),
        na('ACS-787.3-Q09', 'Is load center panel locked and secured?', 1),
        na('ACS-787.3-Q10', 'Is load center properly labeled?', 1),
      ],
    },
  ],
});

export const LIGHTING_TEMPLATES = Object.freeze([
  LIGHTING_POLE_787_1, LIGHTING_REPAIR_787_2, LIGHTING_INSPECTION_787_3,
]);
