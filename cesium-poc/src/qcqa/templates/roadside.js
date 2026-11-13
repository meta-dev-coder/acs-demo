/**
 * Roadside hardware checklists, extracted verbatim from the ACS PDFs.
 *
 * Question text is the form's own wording, including its units and spec references. Nothing here
 * is paraphrased, and no question, threshold or evidence requirement has been added.
 */
import { POLARITY, RESPONSE_TYPES, TEMPLATE_SCOPE, VALIDATION_TYPES } from '../schema.js';

const { YES_NO, YES_NO_NA } = RESPONSE_TYPES;
const { YES_IS_PASS } = POLARITY;
const C = VALIDATION_TYPES.CHECKLIST_RESPONSE;

/** Every form in this file shares the same header block. */
export const STANDARD_HEADER = Object.freeze([
  { field: 'siteLocation', label: 'Site Location', responseType: RESPONSE_TYPES.TEXT },
  { field: 'date', label: 'Date', responseType: RESPONSE_TYPES.DATE },
  { field: 'inspectedBy', label: 'Inspected by', responseType: RESPONSE_TYPES.TEXT },
  { field: 'laneDirection', label: 'Lane Direction', responseType: RESPONSE_TYPES.TEXT,
    options: ['NB', 'SB', 'EB', 'WB'] },
  { field: 'zone', label: 'Zone', responseType: RESPONSE_TYPES.TEXT,
    options: ['1', '2', '3', '4', '5', '6', '7', '8a', '8b'] },
  { field: 'stateRoad', label: 'SR', responseType: RESPONSE_TYPES.TEXT },
  { field: 'workOrderNumber', label: 'WO No.', responseType: RESPONSE_TYPES.TEXT },
]);

/** QC and QA signature blocks. Present on every ACS form in this set. */
export const QC_QA_APPROVALS = Object.freeze({ qc: true, qa: true });

const q = (id, text, page, extra = {}) => Object.freeze({
  id, text, sourcePage: page, responseType: YES_NO, polarity: YES_IS_PASS,
  required: true, validationType: C, sourceField: null, evidenceRequirements: [], ...extra,
});

export const GUARDRAIL_526_1 = Object.freeze({
  templateId: 'ACS-526.1',
  title: 'Guardrail Repair QC/QA',
  version: '1.0',
  scope: TEMPLATE_SCOPE.ASSET_SPECIFIC,
  source: { file: '526.1 Guardrail Repair QC_QA.pdf', page: 1 },
  header: STANDARD_HEADER,
  applicability: {
    assetTypes: ['guardrail'],
    workActivities: ['repair', 'replacement', 'installation'],
    incidentTypes: [],
  },
  approvals: QC_QA_APPROVALS,
  sections: [{
    id: 'guardrail',
    title: 'Guardrail QC/QA Checklist',
    questions: [
      q('ACS-526.1-Q01', 'Is the guardrail height for single panel, double rail, or standard thrie-beam installed between 27\'\'-31\'\' high at the center of the rail?', 1,
        { threshold: { min: 27, max: 31, unit: 'in', measure: 'rail height at center' } }),
      q('ACS-526.1-Q02', 'Is the guardrail height for rail with rubrail and modified thrie-beam installed between 27\'\'-31\'\' high at the center of the rail?', 1,
        { threshold: { min: 27, max: 31, unit: 'in', measure: 'rail height at center' } }),
      q('ACS-526.1-Q03', 'Is the rubrail installed 12\'\' from the center of the panel?', 1,
        { threshold: { exact: 12, unit: 'in', measure: 'rubrail offset from panel center' } }),
      q('ACS-526.1-Q04', 'Is the post spacing correct and installed to 6\'3\'\'?', 1,
        { threshold: { exact: 75, unit: 'in', measure: 'post spacing' } }),
      q('ACS-526.1-Q05', 'Are all posts in good condition, functioning as intended, and aligned? (i.e., not twisted, damaged, split)', 1),
      q('ACS-526.1-Q06', 'Are all panels lapped according to traffic flow, and in good condition? (i.e., no perforations, severe damage)', 1),
      q('ACS-526.1-Q07', 'Are the offset blocks intact and functioning as intended? (i.e., not split, cracked)', 1),
      q('ACS-526.1-Q08', 'Are offset blocks secured with appropriate galvanized nails?', 1),
      q('ACS-526.1-Q09', 'Are the object markers spaced properly and the correct type utilized? (Ensure the first object marker is visible from the driving lane)', 1),
      q('ACS-526.1-Q10', 'Is all connecting hardware utilized correctly and in accordance with FDOT Specifications?', 1,
        { referencedStandard: 'FDOT Specifications' }),
      q('ACS-526.1-Q11', 'Is the work area clear of all debris and excess material?', 1),
      q('ACS-526.1-Q12', 'Is groundwork completed in the working zone?', 1),
    ],
  }],
});

export const FENCE_527_1 = Object.freeze({
  templateId: 'ACS-527.1',
  title: 'Fence Repair QC/QA',
  version: '1.0',
  scope: TEMPLATE_SCOPE.ASSET_SPECIFIC,
  source: { file: '527.1 Fence Repair QC_QA.pdf', page: 1 },
  header: STANDARD_HEADER,
  applicability: { assetTypes: ['fence'], workActivities: ['repair', 'installation'], incidentTypes: [] },
  approvals: QC_QA_APPROVALS,
  sections: [{
    id: 'fence',
    title: 'Fence installation QC/QA Checklist',
    questions: [
      q('ACS-527.1-Q01', 'Is the fence fabric of 9-gauge installed on the private property side of the post except on the back side of a 3-degree curve?', 1),
      q('ACS-527.1-Q02', 'Is the galvanized steel line post 1 1/2" or 1 7/8" x 1 5/8" H Beam on 10 ft centers max.? Is the wire attached with wire ties on 12-inch centers?', 1),
      q('ACS-527.1-Q03', 'Is the wire mesh 6 ft high, with 2-inch square openings twisted at the top and bottom?', 1),
      q('ACS-527.1-Q04', 'Is the tension wire of 7-gauge installed, with 2 strands, one at the bottom and one at the top of the fabric, with ties on 2 ft centers?', 1),
      q('ACS-527.1-Q05', 'Are all posts set in concrete, with corner and pull posts 12" x 3\' 6", and line posts 2\' 6" x 10"?', 1),
      q('ACS-527.1-Q06', 'Is the distance between pull post assemblies approximately 350 ft?', 1,
        { threshold: { approx: 350, unit: 'ft', measure: 'pull post assembly spacing' } }),
      q('ACS-527.1-Q07', 'Do the corner, end, and pull posts have 5 tension bands for each tension bar?', 1),
      q('ACS-527.1-Q08', 'Does the corner post assembly consist of 2" corner and 2 - 1 1/2" line posts (set in concrete), 2 truss rods, 2 rail braces, and hardware?', 1),
      q('ACS-527.1-Q09', 'Does the end post assembly consist of 2" end and 1 1/2" line posts (set in concrete), truss rods, rail brace, and hardware?', 1),
      q('ACS-527.1-Q10', 'Does the pull post assembly consist of 2" pull and 2 - 1 1/2" line posts (set in concrete), 2 truss rods, 2 rail braces, and hardware?', 1),
      q('ACS-527.1-Q11', 'Are all rail braces positioned between 6" from the top and 2 ft below the top of the fence?', 1),
      q('ACS-527.1-Q12', 'Does the work and materials meet FDOT Design Standard No. 802 for Type B Fence?', 1,
        { referencedStandard: 'FDOT Design Standard No. 802 (Type B Fence)' }),
    ],
  }],
});

export const ATTENUATOR_531_1 = Object.freeze({
  templateId: 'ACS-531.1',
  title: 'Attenuator Repair QC/QA',
  version: '1.0',
  scope: TEMPLATE_SCOPE.ASSET_SPECIFIC,
  source: { file: '531.1 Attenuator Repair QC_QA.pdf', page: 1 },
  header: STANDARD_HEADER,
  applicability: {
    assetTypes: ['attenuator'],
    assetSubtypes: ['QuadGuard'],
    workActivities: ['repair', 'replacement', 'reset'],
    incidentTypes: [],
  },
  approvals: QC_QA_APPROVALS,
  sections: [{
    id: 'quadguard',
    title: 'QuadGuard Attenuator QC/QA Checklist',
    /** The form is headed QuadGuard. Another make of attenuator is not covered by it. */
    applicabilityRule: { assetSubtype: 'QuadGuard' },
    questions: [
      q('ACS-531.1-Q01', 'Transition Panel fits for the offset?', 1),
      q('ACS-531.1-Q02', 'Clearance of 30” behind rear Fender Panels for slide back?', 1,
        { threshold: { exact: 30, unit: 'in', measure: 'clearance behind rear fender panels' } }),
      q('ACS-531.1-Q03', 'Anchor nuts are torqued to manufacturer specification?', 1,
        { referencedStandard: 'Manufacturer specification' }),
      q('ACS-531.1-Q04', 'Top of Nose panels are 32 1/8” above concrete pad?', 1,
        { threshold: { exact: 32.125, unit: 'in', measure: 'nose panel height above pad' } }),
      q('ACS-531.1-Q05', 'Cartridges are level and the same height in each Bay?', 1),
      q('ACS-531.1-Q06', 'Correct Cartridge is placed in each Bay and pointing to front of system?', 1),
      q('ACS-531.1-Q07', 'Cartridge Hold Down Bracket is secure and engaged with Nose Cartridge?', 1),
      q('ACS-531.1-Q08', 'Every hole and slot in Backup and Monorail is anchored?', 1),
      q('ACS-531.1-Q09', 'If no transition, check for narrow side panels at backup?', 1,
        { responseType: YES_NO_NA, conditional: 'Only where there is no transition panel' }),
      q('ACS-531.1-Q10', 'Anchor stud(s) are 1.5” maximum above the pad?', 1,
        { threshold: { max: 1.5, unit: 'in', measure: 'anchor stud height above pad' } }),
      q('ACS-531.1-Q11', 'Diaphragms attached to the Monorail guides?', 1),
      q('ACS-531.1-Q12', 'Diaphragm Shims installed between Diaphragm & Monorail guides?', 1),
      q('ACS-531.1-Q13', 'Each Fender Panel has a tension Die Spring?', 1),
      q('ACS-531.1-Q14', 'Mushroom Washers lay flat in slots?', 1),
      q('ACS-531.1-Q15', 'Monorail has End Cap attached?', 1),
      q('ACS-531.1-Q16', 'Nose Cartridge is at the same height as Bay Cartridges?', 1),
      q('ACS-531.1-Q17', 'Fender Panel gap is .78” [20 mm] for Narrow systems?', 1,
        { threshold: { exact: 0.78, unit: 'in', measure: 'fender panel gap (narrow systems)' },
          conditional: 'Narrow systems' }),
      q('ACS-531.1-Q18', 'Bolts and nuts are properly tightened?', 1),
      q('ACS-531.1-Q19', 'System is clear of debris?', 1),
    ],
  }],
});

export const END_TREATMENT_350 = Object.freeze({
  templateId: 'ACS-ET-350',
  title: 'End Treatment Installation QC/QA (FLEAT 350, SKT 350 & SRT 350)',
  version: '1.0',
  scope: TEMPLATE_SCOPE.ASSET_SPECIFIC,
  source: { file: 'End Treatment Installation (FLEAT 350, SKT 350 & SRT 350)  QC_QA.pdf', page: 1 },
  header: STANDARD_HEADER,
  applicability: {
    assetTypes: ['end treatment', 'guardrail'],
    assetSubtypes: ['FLEAT 350', 'SKT 350', 'SRT 350'],
    workActivities: ['installation', 'repair', 'replacement'],
    incidentTypes: [],
  },
  approvals: QC_QA_APPROVALS,
  sections: [
    {
      id: 'common',
      title: 'Common Elements',
      questions: [
        q('ACS-ET-350-Q01', 'Is the face of the rail at the approach end (Post #1) 4\' offset from the main guardrail?', 1,
          { threshold: { exact: 4, unit: 'ft', measure: 'approach end offset' } }),
        q('ACS-ET-350-Q02', 'Is the overlap correct, height to center 21" +3"/-1", and free of debris?', 1,
          { threshold: { exact: 21, plus: 3, minus: 1, unit: 'in', measure: 'height to center' } }),
        q('ACS-ET-350-Q03', 'Is the post inclination and foundation condition acceptable?', 1),
      ],
    },
    {
      id: 'fleat350',
      title: 'FLEAT 350',
      applicabilityRule: { assetSubtype: 'FLEAT 350' },
      conditionalNote: 'If applicable, if not continue to next section',
      questions: [
        q('ACS-ET-350-Q04', 'Are all posts from Post #1 to Post #9 installed correctly according to specifications?', 1, { responseType: YES_NO_NA }),
        q('ACS-ET-350-Q05', 'Is the cable assembly not frayed or damaged and correctly installed?', 1, { responseType: YES_NO_NA }),
        q('ACS-ET-350-Q06', 'Are reflectors positioned correctly and visible from the driving lane?', 1, { responseType: YES_NO_NA }),
      ],
    },
    {
      id: 'skt350',
      title: 'SKT 350',
      applicabilityRule: { assetSubtype: 'SKT 350' },
      conditionalNote: 'If applicable, if not continue to next section',
      questions: [
        q('ACS-ET-350-Q07', 'Is the spacing of 75" on all posts and total effective length of 50\' maintained?', 1,
          { responseType: YES_NO_NA, threshold: { exact: 75, unit: 'in', measure: 'post spacing' } }),
        q('ACS-ET-350-Q08', 'Is the SKT impact head installed and secured to Post #1 with the required lag screws?', 1, { responseType: YES_NO_NA }),
        q('ACS-ET-350-Q09', 'Are reflectors positioned correctly and visible from the driving lane?', 1, { responseType: YES_NO_NA }),
      ],
    },
    {
      id: 'srt350',
      title: 'SRT 350',
      applicabilityRule: { assetSubtype: 'SRT 350' },
      conditionalNote: 'If applicable, if not NA',
      questions: [
        q('ACS-ET-350-Q10', 'Is the post configuration from Post #1 to Post #9 installed correctly according to specifications?', 1, { responseType: YES_NO_NA }),
        q('ACS-ET-350-Q11', 'Are the slot guards installed correctly behind the slots?', 1, { responseType: YES_NO_NA }),
        q('ACS-ET-350-Q12', 'Is the cable assembly not frayed or damaged and correctly installed?', 1, { responseType: YES_NO_NA }),
      ],
    },
  ],
});

export const END_TREATMENT_TYPE_II_IV = Object.freeze({
  templateId: 'ACS-ET-TYPE',
  title: 'End Treatment Installation QC/QA (TYPE II & TYPE IV)',
  version: '1.0',
  scope: TEMPLATE_SCOPE.ASSET_SPECIFIC,
  source: { file: 'End Treatment Installation (TYPE II & TYPE IV )  QC_QA.pdf', page: 1 },
  header: STANDARD_HEADER,
  applicability: {
    assetTypes: ['end treatment', 'guardrail'],
    assetSubtypes: ['Type II', 'Type IV'],
    workActivities: ['installation', 'repair', 'replacement'],
    incidentTypes: [],
  },
  approvals: QC_QA_APPROVALS,
  sections: [
    {
      id: 'common',
      title: 'Common Elements',
      questions: [
        q('ACS-ET-TYPE-Q01', 'Is the overlap correct, height to center 21" +3"/-1", and free of debris?', 1,
          { threshold: { exact: 21, plus: 3, minus: 1, unit: 'in', measure: 'height to center' } }),
        q('ACS-ET-TYPE-Q02', 'Is the post inclination and foundation condition acceptable?', 1),
      ],
    },
    {
      id: 'typeII',
      title: 'TYPE II',
      applicabilityRule: { assetSubtype: 'Type II' },
      conditionalNote: 'If applicable, if not continue to next section',
      questions: [
        q('ACS-ET-TYPE-Q03', 'Are single and double face posts installed correctly with the specified hardware?', 1, { responseType: YES_NO_NA }),
        q('ACS-ET-TYPE-Q04', 'Is the buffer end installed and secured as required?', 1, { responseType: YES_NO_NA }),
        q('ACS-ET-TYPE-Q05', 'Is the cable assembly not frayed or damaged and correctly installed?', 1, { responseType: YES_NO_NA }),
      ],
    },
    {
      id: 'typeIV',
      title: 'TYPE IV',
      applicabilityRule: { assetSubtype: 'Type IV' },
      conditionalNote: 'If applicable, if not NA',
      questions: [
        q('ACS-ET-TYPE-Q06', 'Is the post and panel spacing from Post #1 to Post #8 correct according to specifications?', 1, { responseType: YES_NO_NA }),
        q('ACS-ET-TYPE-Q07', 'Are the reflectors installed and visible from the driving lane?', 1, { responseType: YES_NO_NA }),
        q('ACS-ET-TYPE-Q08', 'Is the cable assembly not frayed or damaged and correctly installed?', 1, { responseType: YES_NO_NA }),
        q('ACS-ET-TYPE-Q09', 'Is the delineator used on the FDOT QPL, and is it correctly listed?', 1,
          { responseType: YES_NO_NA, referencedStandard: 'FDOT Qualified Product List (QPL)' }),
      ],
    },
  ],
});

export const ROADSIDE_TEMPLATES = Object.freeze([
  GUARDRAIL_526_1, FENCE_527_1, ATTENUATOR_531_1, END_TREATMENT_350, END_TREATMENT_TYPE_II_IV,
]);
