/**
 * The scenarios an operator starts from.
 *
 * Each one is a named set of CHANGES to the baseline response, never a set of results. The engine
 * produces the numbers; a preset only says what would be different about the response.
 *
 * Every preset states the operational change it represents and what it would take in the real
 * world, because "early detection" is free in a simulation and is not free on a corridor.
 */

export const SCENARIO_PRESETS = Object.freeze([
  {
    id: 'standard',
    label: 'Standard response',
    summary: 'The response as the assumptions describe it, with nothing improved.',
    requires: 'Nothing. This is the reference the others are measured against.',
    changes: {},
  },
  {
    id: 'earlyDetection',
    label: 'Early detection and dispatch',
    summary: 'The incident is seen and confirmed sooner, and the crew is sent sooner.',
    requires: 'Camera coverage of this stretch with an operator watching it, or automated incident '
      + 'detection. Both are capital and staffing decisions.',
    changes: { detectionMinutes: 2, verificationMinutes: 2, dispatchMinutes: 2 },
  },
  {
    id: 'prepositionedRanger',
    label: 'Pre-positioned Road Ranger',
    summary: 'A patrol is already on this stretch, so the first responder arrives much sooner.',
    requires: 'A patrol beat covering this section during this period — which means a patrol not '
      + 'covering somewhere else. No patrol data exists on this instance to say whether it is possible.',
    changes: { rangerTravelMinutes: 5, rangers: 2 },
  },
  {
    id: 'prepositionedTow',
    label: 'Pre-positioned tow',
    summary: 'A tow is rolled on the first report rather than after verification, from closer by.',
    requires: 'A standing tow contract with a staged unit, and the authority to roll it before an '
      + 'incident is confirmed — which accepts some wasted call-outs.',
    changes: { towTravelMinutes: 10, towDispatchOffsetMinutes: -8 },
  },
  {
    id: 'earlyWarning',
    label: 'Early upstream warning',
    summary: 'Upstream signs warn of the queue sooner. Clearance is unchanged; exposure is not.',
    requires: 'A message sign upstream of this section and a rule that lets the TMC post to it '
      + 'before the incident is fully verified.',
    changes: { warningActivationMinutes: 3 },
  },
  {
    id: 'earlyPartialReopen',
    label: 'Earlier partial reopening',
    summary: 'One lane is given back as soon as the scene allows, rather than at the end.',
    requires: 'A scene that can be worked from a closed lane, and a supervisor willing to authorise '
      + 'it. The investigation hold still applies in full.',
    changes: { partialReopenAfterProtectionMinutes: 5 },
  },
  {
    id: 'coordinated',
    label: 'Coordinated response',
    summary: 'Every feasible improvement together: faster detection, a closer patrol, a tow already '
      + 'rolling, earlier warnings and an early partial reopening.',
    requires: 'All of the above at once. This is the most expensive option and the one least likely '
      + 'to be available on an ordinary day.',
    changes: {
      detectionMinutes: 2, verificationMinutes: 2, dispatchMinutes: 2,
      rangerTravelMinutes: 5, rangers: 2,
      towTravelMinutes: 10, towDispatchOffsetMinutes: -8,
      warningActivationMinutes: 3, partialReopenAfterProtectionMinutes: 5,
    },
  },
]);

export const presetById = id => SCENARIO_PRESETS.find(preset => preset.id === id) ?? null;
