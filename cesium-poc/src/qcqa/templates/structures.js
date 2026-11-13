/** Bridge, concrete, structure and building checklists, extracted verbatim from the ACS PDFs. */
import { POLARITY, RESPONSE_TYPES, TEMPLATE_SCOPE, VALIDATION_TYPES } from '../schema.js';
import { QC_QA_APPROVALS, STANDARD_HEADER } from './roadside.js';

const { YES_NO, YES_NO_NA } = RESPONSE_TYPES;
const q = (id, text, page, extra = {}) => Object.freeze({
  id, text, sourcePage: page, responseType: YES_NO, polarity: POLARITY.YES_IS_PASS,
  required: true, validationType: VALIDATION_TYPES.CHECKLIST_RESPONSE,
  sourceField: null, evidenceRequirements: [], ...extra,
});
const na = (id, text, page, extra = {}) => q(id, text, page, { responseType: YES_NO_NA, ...extra });

export const BRIDGE_INSPECTION_901_1 = Object.freeze({
  templateId: 'ACS-901.1',
  title: 'Bridge Inspection QC/QA',
  version: '1.0',
  scope: TEMPLATE_SCOPE.ASSET_SPECIFIC,
  source: { file: '901.1 Bridge Inspection QC_QA.pdf', page: 1 },
  header: STANDARD_HEADER,
  applicability: { assetTypes: ['bridges'], workActivities: ['inspection'], incidentTypes: [] },
  approvals: QC_QA_APPROVALS,
  sections: [
    {
      id: 'reportReview',
      title: 'Structures Inspection Report Review QC/QA Checklist',
      questions: [
        q('ACS-901.1-Q01', 'Was the inspection performed in accordance with FDOT Procedure 850-010-030?', 1,
          { referencedStandard: 'FDOT Procedure 850-010-030' }),
        na('ACS-901.1-Q02', 'Was the proper procedure followed for lane closure requests? (If applicable)', 1,
          { conditional: 'If applicable' }),
        q('ACS-901.1-Q03', 'Were the proper safety procedures enacted during the inspection? (QC/QA verify only if on site during inspection or if call in report had insufficient safety precautions)', 1,
          { verifiabilityNote: 'QC/QA verify only if on site during inspection' }),
        q('ACS-901.1-Q04', 'Were the correct MOT procedures followed during the inspection? (QC/QA verify only if on site during repairs or if call in report included insufficient MOT)', 1,
          { verifiabilityNote: 'QC/QA verify only if on site during repairs' }),
        q('ACS-901.1-Q05', 'Was the inspection performed on or within the dates of the required inspection cycle (e.g., 2-year inspection cycle for bridges, 5 years for high mast lighting)?', 1,
          { threshold: { cycleYears: { bridge: 2, highMastLighting: 5 }, measure: 'inspection cycle' } }),
        q('ACS-901.1-Q06', 'Was the report submitted within the time limit as designated by the contract?', 1),
      ],
    },
    {
      id: 'bridgeQc',
      title: 'Bridge Inspection QC Checklist',
      questions: [
        q('ACS-901.1-Q07', 'Were the inspection findings reported in the FDOT Pontis System within the specified number of days after inspection completion?', 1,
          { referencedStandard: 'FDOT Pontis System' }),
        q('ACS-901.1-Q08', 'Was the first draft of the report submitted to ACS O&M within the specified number of days after inspection completion?', 1),
        q('ACS-901.1-Q09', 'Was the final draft submitted to ACS O&M within the specified number of days after construction completion?', 1),
        q('ACS-901.1-Q10', 'Was the final report submitted to the client within the specified number of days after inspection completion with a cover letter included?', 1,
          { evidenceRequirements: ['Final report', 'Cover letter'] }),
        q('ACS-901.1-Q11', 'Is the report complete, including descriptions and photos of all inspected bridge parts?', 1,
          { evidenceRequirements: ['Photos of all inspected bridge parts'] }),
        q('ACS-901.1-Q12', 'Does the report follow the required format?', 1),
      ],
    },
  ],
});

export const CONCRETE_REPAIR = Object.freeze({
  templateId: 'ACS-CONCRETE',
  title: 'Concrete Repair & Inspection QC/QA',
  version: '1.0',
  scope: TEMPLATE_SCOPE.ASSET_SPECIFIC,
  source: { file: 'Concrete Repair & Inspection QC_QA.pdf', page: 1 },
  header: STANDARD_HEADER,
  applicability: {
    assetTypes: ['sidewalk', 'concrete', 'bridges'],
    workActivities: ['repair', 'inspection'],
    incidentTypes: [],
  },
  approvals: QC_QA_APPROVALS,
  sections: [
    {
      id: 'inspection',
      title: 'INSPECTION',
      conditionalNote: 'If applicable, if not continue to next section',
      questions: [
        na('ACS-CONCRETE-Q01', 'Was the repair made in accordance with the work order?', 1),
      ],
    },
    {
      id: 'repair',
      title: 'REPAIR QC/QA Checklist',
      conditionalNote: 'If applicable, if not NA',
      questions: [
        na('ACS-CONCRETE-Q02', 'Were all products and materials used during the operation in accordance with the FDOT Qualified Product List (QPL) and all work performed in accordance with FDOT\'s Maintenance Special?', 1,
          { referencedStandard: 'FDOT Qualified Product List (QPL); FDOT Maintenance Special' }),
        na('ACS-CONCRETE-Q03', 'Was all required MOT initiated and utilized correctly during the repair? (Note: QA, and QC can only confirm if on-site during operation)', 1,
          { verifiabilityNote: 'QA and QC can only confirm if on-site during operation' }),
        na('ACS-CONCRETE-Q04', 'Does the concrete mixture meet all concentration requirements as outlined by FDOT Specifications? (QA, QC will only need to review the ticket for verification)', 1,
          { referencedStandard: 'FDOT Specifications', evidenceRequirements: ['Concrete ticket'] }),
        na('ACS-CONCRETE-Q05', 'Is all repair work in accordance with as-built design plans or the most current FDOT design standards and specifications?', 1,
          { referencedStandard: 'As-built design plans; current FDOT design standards' }),
        na('ACS-CONCRETE-Q06', 'Is all repair work performed during optimal weather conditions as required by manufacturer recommendations?', 1),
        na('ACS-CONCRETE-Q07', 'Is all excess material and debris removed from the job site and disposed of according to all State and Federal regulations?', 1),
        na('ACS-CONCRETE-Q08', 'Does the repaired concrete meet all FDOT standards and specifications after curing?', 1,
          { referencedStandard: 'FDOT standards and specifications' }),
      ],
    },
  ],
});

export const STRUCTURE_MAINTENANCE = Object.freeze({
  templateId: 'ACS-STRUCTURE',
  title: 'Structure Maintenance & Repair QC/QA',
  version: '1.0',
  scope: TEMPLATE_SCOPE.ASSET_SPECIFIC,
  source: { file: 'Structure Maintenance & Repair QC_QA.pdf', page: 1 },
  header: STANDARD_HEADER,
  applicability: {
    assetTypes: ['bridges', 'sign structures', 'structure'],
    workActivities: ['repair', 'maintenance'],
    incidentTypes: [],
  },
  approvals: QC_QA_APPROVALS,
  sections: [
    {
      id: 'repair',
      title: 'Repair',
      questions: [
        q('ACS-STRUCTURE-Q01', 'Is the repair in accordance with the deficiency noted from the inspection?', 1),
        na('ACS-STRUCTURE-Q02', 'Was the repair in accordance with the design drawings? (If applicable)', 1,
          { conditional: 'If applicable' }),
        q('ACS-STRUCTURE-Q03', 'Was the repair made in accordance with FDOT applicable design Standards and the Standard Specifications for Road & Bridge Construction?', 1,
          { referencedStandard: 'FDOT design Standards; Standard Specifications for Road & Bridge Construction' }),
        q('ACS-STRUCTURE-Q04', 'Was the repair made within the designated time frame as outlined in contract requirements?', 1),
        q('ACS-STRUCTURE-Q05', 'Was the repair made utilizing all FDOT approved products and procedures as outlined in the FDOT Standards for Road and Bridge Construction, design standards, and QPL requirement?', 1,
          { referencedStandard: 'FDOT Standards for Road and Bridge Construction; QPL' }),
        na('ACS-STRUCTURE-Q06', 'If the repair required a lane closure, was the proper procedure for closure request followed?', 1,
          { conditional: 'If the repair required a lane closure' }),
        q('ACS-STRUCTURE-Q07', 'Were the proper safety procedures enacted during the repair? (QC/QA verify only if on site during repairs or if call in report included insufficient safety precautions)', 1,
          { verifiabilityNote: 'QC/QA verify only if on site during repairs' }),
        q('ACS-STRUCTURE-Q08', 'Were the correct MOT procedures followed during the repair? (QC/QA verify only if on site during repairs or if call in report included insufficient MOT)', 1,
          { verifiabilityNote: 'QC/QA verify only if on site during repairs' }),
        q('ACS-STRUCTURE-Q09', 'Did the subcontractor notify ASC O&M upon completion of repairs?', 1),
      ],
    },
    {
      id: 'documentation',
      title: 'Repair Documentation QC/QA Checklist',
      questions: [
        na('ACS-STRUCTURE-Q10', 'Was the ASC O&M Work Order and FDOT NBIS Work Order closed out (if applicable)?', 1,
          { conditional: 'If applicable' }),
        q('ACS-STRUCTURE-Q11', 'Did the repair report include photo documentation of each repair performed?', 1,
          { evidenceRequirements: ['Photo documentation of each repair'] }),
        q('ACS-STRUCTURE-Q12', 'Was all the supporting repair documentation included in the repair report?', 1,
          { evidenceRequirements: ['Supporting repair documentation'] }),
        na('ACS-STRUCTURE-Q13', 'Was all repair information updated in Pontis (if applicable)?', 1,
          { referencedStandard: 'FDOT Pontis System', conditional: 'If applicable' }),
      ],
    },
  ],
});

export const TOLL_BUILDING = Object.freeze({
  templateId: 'ACS-TOLL-ITS',
  title: 'Toll Building and ITS Hubs Annual Inspection QC/QA',
  version: '1.0',
  scope: TEMPLATE_SCOPE.ASSET_SPECIFIC,
  source: { file: 'Toll Building and ITS Hubs Annual Inspection QC_QA.pdf', page: 1 },
  header: STANDARD_HEADER,
  applicability: {
    assetTypes: ['communication hub', 'toll building', 'its hub'],
    workActivities: ['inspection', 'preventive maintenance'],
    incidentTypes: [],
  },
  approvals: QC_QA_APPROVALS,
  sections: [{
    id: 'tollIts',
    title: 'Toll Building / ITS Hubs QC/QA Checklist',
    questions: [
      na('ACS-TOLL-ITS-Q01', 'Were all corrective actions indicated in the original inspection report executed?', 1),
      na('ACS-TOLL-ITS-Q02', 'Is the area free of debris, trash, and leftover materials?', 1),
      na('ACS-TOLL-ITS-Q03', 'Was vegetation properly removed or controlled as requested?', 1),
      na('ACS-TOLL-ITS-Q04', 'Were rusted or deteriorated metal surfaces cleaned, sanded, or properly treated?', 1),
      na('ACS-TOLL-ITS-Q05', 'Were all reported safety hazards corrected?', 1),
      na('ACS-TOLL-ITS-Q06', 'Does the final visual appearance meet project presentation standards?', 1),
      na('ACS-TOLL-ITS-Q07', 'Was the work completed within the expected timeframe and response period?', 1),
    ],
  }],
});

export const STRUCTURE_TEMPLATES = Object.freeze([
  BRIDGE_INSPECTION_901_1, CONCRETE_REPAIR, STRUCTURE_MAINTENANCE, TOLL_BUILDING,
]);
