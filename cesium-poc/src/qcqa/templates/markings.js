/** Pavement marking and RPM checklists, extracted verbatim from the ACS PDFs. */
import { POLARITY, RESPONSE_TYPES, TEMPLATE_SCOPE, VALIDATION_TYPES } from '../schema.js';
import { QC_QA_APPROVALS, STANDARD_HEADER } from './roadside.js';

const q = (id, text, page, extra = {}) => Object.freeze({
  id, text, sourcePage: page, responseType: RESPONSE_TYPES.YES_NO, polarity: POLARITY.YES_IS_PASS,
  required: true, validationType: VALIDATION_TYPES.CHECKLIST_RESPONSE,
  sourceField: null, evidenceRequirements: [], ...extra,
});

export const PAVEMENT_SYMBOLS_534_1 = Object.freeze({
  templateId: 'ACS-534.1',
  title: 'Pavement Symbols Installation QC/QA',
  version: '1.0',
  scope: TEMPLATE_SCOPE.ASSET_SPECIFIC,
  source: { file: '534.1 Pavement Symbols Installation QC_QA.pdf', page: 1 },
  /** The scanned copy notes the Name field as "(Si es que vamos a poner point of interest)". */
  extractionNote: 'Scanned document. Text read from the page; header Name field carries an inline '
    + 'Spanish annotation in the original. Checklist rows verified against the scan.',
  header: STANDARD_HEADER,
  applicability: {
    assetTypes: ['pavement marking'],
    workActivities: ['installation', 'repair', 'replacement'],
    incidentTypes: [],
  },
  approvals: QC_QA_APPROVALS,
  sections: [{
    id: 'markings',
    title: 'Pavement Markings Installation QC/QA Checklist',
    questions: [
      q('ACS-534.1-Q01', 'Was the product used listed on the most current Qualified Product List (QPL)?', 1,
        { referencedStandard: 'FDOT Qualified Product List (QPL)' }),
      q('ACS-534.1-Q02', 'Is the alignment, width, placement, and color coordination correct for each pavement marking as specified in FDOT Design Standards 1700 Series and Standard Specification Sections 710, 711, and 713?', 1,
        { referencedStandard: 'FDOT Design Standards 1700 Series; Standard Specification Sections 710, 711, 713' }),
      q('ACS-534.1-Q03', 'If the removal of old pavement marking was necessary, were FDOT-approved methods followed and the remnant materials removed before new striping/marking was installed?', 1,
        { responseType: RESPONSE_TYPES.YES_NO_NA, conditional: 'If removal of old marking was necessary' }),
      q('ACS-534.1-Q04', 'Was the pavement marking installed under the correct conditions as per manufacturer\'s recommendations? (e.g., weather conditions, application rate, etc.)', 1),
      q('ACS-534.1-Q05', 'Does the pavement marking meet the daytime and night chromaticity requirements in Section 971 of FDOT Specifications for Road and Bridge Construction?', 1,
        { referencedStandard: 'FDOT Specifications for Road and Bridge Construction, Section 971' }),
    ],
  }],
});

export const RPM_537_1 = Object.freeze({
  templateId: 'ACS-537.1',
  title: 'Raised Pavement Markers Installation QC/QA',
  version: '1.0',
  scope: TEMPLATE_SCOPE.ASSET_SPECIFIC,
  source: { file: '537.1 Raised Payment Markers Installation QC_QA.pdf', page: 1 },
  header: STANDARD_HEADER,
  applicability: {
    assetTypes: ['raised pavement marker', 'pavement marking'],
    workActivities: ['installation', 'repair', 'replacement'],
    incidentTypes: [],
  },
  approvals: QC_QA_APPROVALS,
  sections: [{
    id: 'rpm',
    title: 'RPM Installation QC/QA Checklist',
    questions: [
      q('ACS-537.1-Q01', 'Are all markers used from FDOT\'s Qualified Product List (QPL), and is the manufacturer\'s certificate of analysis retained on file?', 1,
        { referencedStandard: 'FDOT Qualified Product List (QPL)',
          evidenceRequirements: ['Manufacturer\'s certificate of analysis'] }),
      q('ACS-537.1-Q02', 'Is the bituminous adhesive used an approved product on FDOT\'s QPL, and is the manufacturer\'s certificate of analysis retained on file?', 1,
        { referencedStandard: 'FDOT Qualified Product List (QPL)',
          evidenceRequirements: ['Manufacturer\'s certificate of analysis'] }),
      q('ACS-537.1-Q03', 'Were all markers installed per manufacturer\'s recommendations and in accordance with FDOT\'s Standard Specifications Section 970?', 1,
        { referencedStandard: 'FDOT Standard Specifications Section 970' }),
      q('ACS-537.1-Q04', 'Were all RPMs installed in the correct reflectivity orientation?', 1),
      q('ACS-537.1-Q05', 'Are all RPMs installed with the correct spacing for the specific application and in the correct location? (e.g., mainline, gore, ramp, other outside/inside specs)', 1),
      q('ACS-537.1-Q06', 'Are all RPMs installed so as not to be skewed from the view of traffic?', 1),
      q('ACS-537.1-Q07', 'Are the correct RPMs used with the corresponding traffic striping? (e.g., red/clear, amber/amber, amber/red, amber/blank, clear/clear)', 1),
      q('ACS-537.1-Q08', 'Are all RPMs installed at the correct traffic striping centers?', 1),
      q('ACS-537.1-Q09', 'Do no more than 2% of the RPMs installed fail to meet adhesion or alignment criteria within the first 45 days after installation?', 1,
        { threshold: { max: 2, unit: '%', measure: 'RPMs failing adhesion or alignment within 45 days' } }),
    ],
  }],
});

export const MARKING_TEMPLATES = Object.freeze([PAVEMENT_SYMBOLS_534_1, RPM_537_1]);
