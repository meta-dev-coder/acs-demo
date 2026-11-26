/**
 * Ask the Twin questions for the IFC network: the electrical twin's 30 acceptance questions
 * (seagirt/questionBank.js), same six categories and the same question types, reworded for the
 * equipment the IFC model contains (TX-M1, BUS-B, STS-05, AP-03...). Q8 asks for the supplying ring
 * main unit because the IFC network's only breaker is the normally-open bus tie.
 */
export const IFC_QUESTION_BANK = Object.freeze([
  { name: 'Electrical Asset Identification & Location', short: 'Identify', questions: [
    'Where is Transformer TX-M1 located? Highlight it on the terminal map.',
    'Show me all transformers installed across Seagirt Marine Terminal.',
    'Which switchgear is connected to Transformer TX-M2?',
    'Where are all the electrical substations and switching stations located?',
    'Show all cranes connected to the electrical distribution network.',
  ] },
  { name: 'Electrical Connectivity & Network Tracing', short: 'Trace', questions: [
    'Which transformer supplies power to Crane STS-05?',
    'Show the complete electrical connection path from the utility supply to Crane STS-09.',
    'Which ring main unit controls the electrical supply to the truck gate GATE?',
    'What equipment is connected downstream of Switchgear BUS-B?',
    'Show all transformers, switches, and cables connected to Switchgear BUS-A.',
  ] },
  { name: 'Power Outage & Failure Impact Analysis', short: 'Outage', questions: [
    'What happens if Transformer TX-M2 goes offline?',
    'Which cranes will lose power if cable AP-03 fails?',
    'If Switchgear BUS-A fails, which buildings, lighting circuits, and cranes will be affected?',
    'Highlight all electrical equipment that would lose power if Feeder F2 is disconnected.',
    'If Substation USS-5 is taken offline for maintenance, what downstream equipment will be impacted?',
  ] },
  { name: 'Electrical Redundancy & Alternative Power Supply', short: 'Redundancy', questions: [
    'Does Crane STS-03 have an alternative electrical supply?',
    'If Transformer TX-M2 fails, can Transformer TX-M1 supply the affected equipment?',
    'Which electrical assets have no redundant power supply?',
    'Show all cranes that depend on a single transformer.',
    'Which alternate feeder could supply Reefers R2 during a planned shutdown?',
  ] },
  { name: 'Asset Condition, Inspection & Maintenance', short: 'Condition', questions: [
    'When was Transformer TX-3 last inspected, and what was its condition?',
    'Which transformers have overdue electrical inspections?',
    'Show all switchgear units classified as poor condition.',
    'Which electrical assets are scheduled for replacement within the next 12 months?',
    'Show the maintenance history and open work orders for Bus tie breaker BT-1.',
  ] },
  { name: 'Advanced Electrical Engineering & Planning', short: 'Engineering', questions: [
    'What is the current electrical load on Transformer TX-M1 compared with its rated capacity?',
    'If a new electric crane is connected to Feeder F3, will the feeder and upstream transformer have sufficient capacity?',
    'What is the expected voltage drop at Crane STS-12 during peak operating load?',
    'If Transformer TX-M2 is taken offline, will transferring its loads to TX-M1 create an overload?',
    'Which circuit breakers may exceed their interrupting ratings under the modeled short-circuit conditions?',
  ] },
]);
