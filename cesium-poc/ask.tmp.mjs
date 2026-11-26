import { readFileSync } from 'node:fs';
import { buildIfcNetwork } from './src/ifcSpatial/ifcNetwork.js';
import { IFC_QUESTION_BANK } from './src/ifcSpatial/ifcQuestionBank.js';
import { createScenarioSession } from './src/seagirt/outageScenario.js';
import { ask, validateResult } from './src/seagirt/askSeagirt.js';
const fx = JSON.parse(readFileSync('tests/fixtures/ifc-network.json', 'utf8'));
const { assets, edges, network } = buildIfcNetwork({ ...fx, toLonLat: (x, y, z) => ({ lon: -76.54 + x / 86000, lat: 39.256 + y / 111000, height: z }) });
let n = 0;
for (const c of IFC_QUESTION_BANK) for (const q of c.questions) {
  n += 1;
  const session = createScenarioSession({ assets, edges, notes: network.notes });
  const { parsed, answer } = ask(q, { network: session.network, session, today: '2026-11-23' });
  const { result } = validateResult(answer, session.network);
  console.log(`\nQ${n} [${result.intent}/${result.status}] ${q}\n  subj=${parsed.subject} named=${parsed.named} types=${parsed.types}\n  ${result.answer.title}\n  ${result.answer.summary?.slice(0, 260)}`);
  if (result.answer.lines?.length) console.log('  ·', result.answer.lines.slice(0, 3).join(' | ').slice(0, 300));
}
