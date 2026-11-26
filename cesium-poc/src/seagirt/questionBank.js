/**
 * The Kimley-Horn acceptance questions for the Seagirt electrical twin (AskTheTwin.rtf), verbatim,
 * in their six categories. Offered under Ask the Twin; the acceptance tests ask exactly these
 * (`tests/fixtures/seagirt-ask-the-twin-questions.json` must match).
 */
export const QUESTION_BANK = Object.freeze([
  { name: 'Electrical Asset Identification & Location', short: 'Find equipment', questions: [
    'Where is Transformer T1 located? Highlight it on the terminal map.',
    'Show me all transformers installed across Seagirt Marine Terminal.',
    'Which switchgear is connected to Transformer T2?',
    'Where are all the electrical substations and distribution panels located?',
    'Show all cranes connected to the electrical distribution network.',
  ] },
  { name: 'Electrical Connectivity & Network Tracing', short: 'Trace connectivity', questions: [
    'Which transformer supplies power to Crane C1?',
    'Show the complete electrical connection path from the main supply to Crane C3.',
    'Which circuit breaker controls the electrical supply to Warehouse W1?',
    'What equipment is connected downstream of Switchgear S2?',
    'Show all transformers, breakers, and feeders connected to Substation SS1.',
  ] },
  { name: 'Power Outage & Failure Impact Analysis', short: 'Outage impact', questions: [
    'What happens if Transformer T1 goes offline?',
    'Which cranes will lose power if Circuit Breaker CB4 is opened?',
    'If Switchgear S1 fails, which buildings, lighting circuits, and cranes will be affected?',
    'Highlight all electrical equipment that would lose power if Feeder F2 is disconnected.',
    'If Substation SS1 is taken offline for maintenance, what downstream equipment will be impacted?',
  ] },
  { name: 'Electrical Redundancy & Alternative Power Supply', short: 'Redundancy', questions: [
    'Does Crane C2 have an alternative electrical supply?',
    'If Transformer T1 fails, can Transformer T2 supply the affected equipment?',
    'Which electrical assets have no redundant power supply?',
    'Show all cranes that depend on a single transformer.',
    'Which alternate feeder could supply Warehouse W2 during a planned shutdown?',
  ] },
  { name: 'Asset Condition, Inspection & Maintenance', short: 'Condition & maintenance', questions: [
    'When was Transformer T3 last inspected, and what was its condition?',
    'Which transformers have overdue electrical inspections?',
    'Show all switchgear units classified as poor condition.',
    'Which electrical assets are scheduled for replacement within the next 12 months?',
    'Show the maintenance history and open work orders for Circuit Breaker CB5.',
  ] },
  { name: 'Advanced Electrical Engineering & Planning', short: 'Engineering studies', questions: [
    'What is the current electrical load on Transformer T1 compared with its rated capacity?',
    'If a new electric crane is connected to Feeder F3, will the feeder and upstream transformer have sufficient capacity?',
    'What is the expected voltage drop at Crane C4 during peak operating load?',
    'If Transformer T2 is taken offline, will transferring its loads to T3 create an overload?',
    'Which circuit breakers may exceed their interrupting ratings under the modeled short-circuit conditions?',
  ] },
]);
