/**
 * Crew-safety checklists. These are UNIVERSAL: they apply to the crew and the work zone, not to a
 * kind of asset, so they are selected alongside an asset-specific template rather than instead
 * of one.
 */
import { POLARITY, RESPONSE_TYPES, TEMPLATE_SCOPE, VALIDATION_TYPES } from '../schema.js';

const { YES_NO, YES_NO_NA, MULTI_RESPONSE, TEXT } = RESPONSE_TYPES;
const C = VALIDATION_TYPES.CHECKLIST_RESPONSE;

const item = (id, text, category) => Object.freeze({
  id, text, category, sourcePage: 1, responseType: YES_NO_NA, polarity: POLARITY.YES_IS_PASS,
  required: true, validationType: C, sourceField: null, evidenceRequirements: [],
});

/** The Safety Reviews form: five categories, 25 items, each Yes/No/N/A with a comments column. */
export const SAFETY_INSPECTION = Object.freeze({
  templateId: 'ACS-SAFETY',
  title: 'Safety Reviews (ACS Safety Inspection QC)',
  version: '1.0',
  scope: TEMPLATE_SCOPE.UNIVERSAL,
  source: { file: 'ACS Safety Inspection QC.pdf', page: 1 },
  header: Object.freeze([
    { field: 'date', label: 'Date', responseType: RESPONSE_TYPES.DATE },
    { field: 'inspectedBy', label: 'Inspected By', responseType: TEXT },
    { field: 'crewLeader', label: 'Crew Leader', responseType: TEXT },
    { field: 'workOrderNumber', label: 'WO', responseType: TEXT },
    { field: 'siteLocation', label: 'Site Location', responseType: TEXT },
    { field: 'task', label: 'Task', responseType: TEXT },
  ]),
  /** The form carries a single Comments / Action Plan column per category, not per row. */
  commentsScope: 'category',
  applicability: { assetTypes: [], workActivities: [], incidentTypes: [] },
  /** Only a QC signature block on this form. */
  approvals: { qc: true, qa: false },
  sections: [
    {
      id: 'siteSafety',
      title: 'SITE SAFETY',
      questions: [
        item('ACS-SAFETY-Q01', 'Proper Eye Protection for Task', 'SITE SAFETY'),
        item('ACS-SAFETY-Q02', 'Proper Gloves for Task', 'SITE SAFETY'),
        item('ACS-SAFETY-Q03', 'Proper Footwear for Task', 'SITE SAFETY'),
        item('ACS-SAFETY-Q04', 'Proper Ear Protection for Task', 'SITE SAFETY'),
        item('ACS-SAFETY-Q05', 'Proper PPE for Task', 'SITE SAFETY'),
        item('ACS-SAFETY-Q06', 'ANSI Class II Vest / Correct Colors', 'SITE SAFETY'),
        item('ACS-SAFETY-Q07', 'Hardhat Worn Property/ Correct Colors', 'SITE SAFETY'),
      ],
    },
    {
      id: 'employeeSafety',
      title: 'EMPLOYEE SAFETY',
      questions: [
        item('ACS-SAFETY-Q08', 'Clothes Fitting / Clothing Tucked In', 'EMPLOYEE SAFETY'),
        item('ACS-SAFETY-Q09', 'Proper Steps Used to Exit from Equipment', 'EMPLOYEE SAFETY'),
        // The form lists this as an observation. Working with your back to traffic is the hazard,
        // so a YES here is a finding, not a pass.
        Object.freeze({ ...item('ACS-SAFETY-Q10', 'Employees Working with Back to Traffic', 'EMPLOYEE SAFETY'),
          polarity: POLARITY.NO_IS_PASS }),
        item('ACS-SAFETY-Q11', 'Housekeeping (Trash, Trip Hazards)', 'EMPLOYEE SAFETY'),
        item('ACS-SAFETY-Q12', 'Workers Facing Traffic w/ One Watcher', 'EMPLOYEE SAFETY'),
        item('ACS-SAFETY-Q13', 'Workers in Safe Area, Not In Roadway', 'EMPLOYEE SAFETY'),
        item('ACS-SAFETY-Q14', 'Drinking Liquids Available On Site', 'EMPLOYEE SAFETY'),
        item('ACS-SAFETY-Q15', 'First Aid Kits OnSite', 'EMPLOYEE SAFETY'),
      ],
    },
    {
      id: 'workZone',
      title: 'WORK ZONE / HAZARDS',
      questions: [
        item('ACS-SAFETY-Q16', 'Field Kit & Job Hazard Plan On Site', 'WORK ZONE / HAZARDS'),
        item('ACS-SAFETY-Q17', 'Field Hazards Marked / Barricaded', 'WORK ZONE / HAZARDS'),
        item('ACS-SAFETY-Q18', 'Traffic Control Devices Properly Spaced', 'WORK ZONE / HAZARDS'),
        item('ACS-SAFETY-Q19', 'Proper MOT Device Set-Up per Standard', 'WORK ZONE / HAZARDS'),
      ],
    },
    {
      id: 'equipment',
      title: 'EQUIPMENT / VEHICLES',
      questions: [
        item('ACS-SAFETY-Q20', 'Beacons Functioning as Required', 'EQUIPMENT / VEHICLES'),
        item('ACS-SAFETY-Q21', 'Back-Up Alarms Working', 'EQUIPMENT / VEHICLES'),
        item('ACS-SAFETY-Q22', 'Vehicle Maintenance Up to Date', 'EQUIPMENT / VEHICLES'),
        item('ACS-SAFETY-Q23', 'Proper Use of Equipment On Site', 'EQUIPMENT / VEHICLES'),
        item('ACS-SAFETY-Q24', 'Tools in Good Condition / Stored Properly', 'EQUIPMENT / VEHICLES'),
      ],
    },
    {
      id: 'hazmat',
      title: 'HAZARDOUS MATERIAL',
      questions: [
        item('ACS-SAFETY-Q25', 'Hazardous Materials Properly Stored', 'HAZARDOUS MATERIAL'),
        item('ACS-SAFETY-Q26', 'MSDS Available On Site', 'HAZARDOUS MATERIAL'),
      ],
    },
  ],
});

/**
 * PPE compliance.
 *
 * Each item carries TWO independent responses — worn properly, and condition ok — so the question
 * is MULTI_RESPONSE and the engine evaluates each column separately. One can pass while the other
 * fails, and collapsing them to a single answer would lose the distinction the form draws.
 */
const ppe = (id, text) => Object.freeze({
  id, text, sourcePage: 1, responseType: MULTI_RESPONSE, polarity: POLARITY.YES_IS_PASS,
  required: true, validationType: C, sourceField: null, evidenceRequirements: [],
  responses: Object.freeze([
    { key: 'wornProperly', label: 'Wearing Properly?', responseType: YES_NO_NA, polarity: POLARITY.YES_IS_PASS },
    { key: 'conditionOk', label: 'Condition ok?', responseType: YES_NO_NA, polarity: POLARITY.YES_IS_PASS },
  ]),
});

export const PPE_COMPLIANCE = Object.freeze({
  templateId: 'ACS-PPE',
  title: 'Personal Protection Equipment Compliance QC',
  version: '1.0',
  scope: TEMPLATE_SCOPE.UNIVERSAL,
  source: { file: 'Personal Protection Equipment Compliance_QC.pdf', page: 1 },
  header: Object.freeze([
    { field: 'siteLocation', label: 'Site Location', responseType: TEXT },
    { field: 'date', label: 'Date', responseType: RESPONSE_TYPES.DATE },
    { field: 'inspectedBy', label: 'Inspected by', responseType: TEXT },
    { field: 'laneDirection', label: 'Lane Direction', responseType: TEXT, options: ['NB', 'SB', 'EB', 'WB'] },
    { field: 'stateRoad', label: 'SR', responseType: TEXT },
    // This form asks for a Task No., not a WO No.
    { field: 'taskNumber', label: 'Task No.', responseType: TEXT },
  ]),
  applicability: { assetTypes: [], workActivities: [], incidentTypes: [] },
  /** QC signature only — this form has no QA block. */
  approvals: { qc: true, qa: false },
  sections: [
    {
      id: 'ppeItems',
      title: 'Personal Protection Equipment Compliance Check',
      questions: [
        ppe('ACS-PPE-Q01', 'Heavy-Duty Work Gloves'),
        ppe('ACS-PPE-Q02', 'High-Visibility Safety Vest'),
        ppe('ACS-PPE-Q03', 'Clear Safety Glasses'),
        ppe('ACS-PPE-Q04', 'Hard Hat'),
        ppe('ACS-PPE-Q05', 'Steel-Toe Boots'),
        ppe('ACS-PPE-Q06', 'Needle-Resistant Gloves'),
      ],
    },
    {
      id: 'observations',
      title: 'General Compliance Observations',
      questions: [
        Object.freeze({ id: 'ACS-PPE-Q07', text: 'Is the employee aware of PPE requirements?',
          sourcePage: 1, responseType: YES_NO, polarity: POLARITY.YES_IS_PASS, required: true,
          validationType: C, sourceField: null, evidenceRequirements: [] }),
        Object.freeze({ id: 'ACS-PPE-Q08', text: 'Is PPE being used at all times in the work zone?',
          sourcePage: 1, responseType: YES_NO, polarity: POLARITY.YES_IS_PASS, required: true,
          validationType: C, sourceField: null, evidenceRequirements: [] }),
        Object.freeze({ id: 'ACS-PPE-Q09', text: 'Has the employee received proper PPE training?',
          sourcePage: 1, responseType: YES_NO, polarity: POLARITY.YES_IS_PASS, required: true,
          validationType: C, sourceField: null, evidenceRequirements: [] }),
        // "Any modifications or misuse of PPE observed?" — YES is the finding, and the form asks
        // for an explanation when it is.
        Object.freeze({ id: 'ACS-PPE-Q10',
          text: 'Any modifications or misuse of PPE observed? (If Yes, Explain)',
          sourcePage: 1, responseType: YES_NO, polarity: POLARITY.NO_IS_PASS, required: true,
          validationType: C, sourceField: null, evidenceRequirements: [],
          requiresCommentWhen: 'YES' }),
      ],
    },
  ],
});

export const SAFETY_TEMPLATES = Object.freeze([SAFETY_INSPECTION, PPE_COMPLIANCE]);
