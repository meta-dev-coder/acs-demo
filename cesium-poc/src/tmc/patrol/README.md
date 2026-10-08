# Patrol simulation, and how to replace it with real data

The TMC's patrol feature is built against a **provider contract**, not against a simulation. The
workspace calls five methods and never knows what is behind them. Replacing simulated patrols with
real AVL means writing a second provider and changing one line — no TMC UI work.

## What is real and what is not

| | |
|---|---|
| **Real** | the incident, its recorded timestamp, its carriageway, the corridor centerline the patrols stand on |
| **Simulated** | that these vehicles exist, where they are, whether they are free, how fast they could arrive, and every dispatch time |

Every record carries `sourceType: 'SIMULATED'`. Consumers read that field rather than being told, so
a mixed list could state which of its own rows is real. Nothing here is FDOT or ACS operational data.

## The contract

```js
getPatrolsAt(timestamp, context)            // → Patrol[]
getPatrolPositionsAt(timestamp, context)    // → positions only, for a cheap map refresh
getPatrolAvailabilityAt(timestamp, context) // → {total, available, busy, outOfService, engaged}
getDispatchOptions(incident, timestamp, context)
                                            // → {options, eligible, suggested, tied, availability}
getResponseScenario(incident, patrolId, assumptions, context)
                                            // → the timeline
```

Every method is **time-addressed**. The TMC is a historical investigation tool, so "where were the
patrols" is a question about a past instant. A provider that ignored `timestamp` and returned live
positions would be answering a different question.

`describeProvider(provider)` reports which methods are missing; `asPatrolProvider(provider)` throws
on an incomplete one, so a contract breach fails at construction rather than inside a render.

## Writing `RealAvlPatrolProvider`

```js
// src/tmc/patrol/realAvlPatrolProvider.js
export function createRealAvlPatrolProvider({ centerline, fetchPatrols }) {
  return asPatrolProvider({ /* the same five methods */ });
}
```

Then in `tmcWorkspace.js`:

```js
const patrolProvider = createRealAvlPatrolProvider({ centerline, fetchPatrols });
```

Nothing else changes. The Response tab, the map layer, the dispatch arithmetic and the Ask the Twin
actions all consume the provider-neutral model.

### Fields a real feed would need

These are the fields the contract maps onto. They are **suggested integration fields, not a
confirmed SunGuide payload** — the shape would be settled against whatever ACS can actually expose.

| Contract field | Real source |
|---|---|
| `id`, `displayName` | `patrolId`, `vehicleId` |
| `latitude`, `longitude`, `heading`, `speed` | AVL position record |
| `simulationTimestamp` | the AVL `timestamp` (rename to `observedAt` when real) |
| `status` | `availability` / duty status, mapped onto `PATROL_STATUS` |
| `serviceArea`, `assignedRoute` | beat and route assignment |
| — | `assignedIncidentId`, so a patrol working another incident is excluded by fact rather than by a simulated status |
| — | `dispatchTime`, `arrivalTime`, `departureTime`, `clearanceTime` — these turn the **assumed** durations in `patrolConfig.js` into **measured** ones |

### What changes once the times are real

`patrolConfig.dispatchDelayAssumptions` exists only because nothing measures those durations today.
With real dispatch and arrival timestamps, the timeline stops being an assumption and becomes a
record, and the scenario comparison can be validated against what actually happened rather than
asserted. Until then the UI labels every one of them SIMULATED.

### Credentials

Any real integration is a **backend** concern. No patrol API key, token or endpoint belongs in the
browser bundle; the pattern to follow is the existing DataConnect proxy — the server holds the
credential and the frontend calls a same-origin read-only path.

## Routing: what the published geometry supports

This is the sharpest limitation, and it is deliberate rather than unfinished.

**Available:** one shared mainline centerline, cumulative distances along it, a projection from any
point onto it, and direction of travel per carriageway from the corridor's own `travel_order`.

**Not available:** ramp and interchange topology. The 367 published lines carry geometry but no
junction nodes, no connection table and no turn legality. Nothing published says where a vehicle may
cross or turn around on a divided highway, and I-595 Express does not publish its direction at all.

So a route is offered in **exactly one case**: the patrol is upstream of the incident on the same
general-purpose carriageway. The distance is then measured along real centerline geometry and the
drawn line is the real centerline slice. Every other case returns `resolved: false` with a reason,
and **no travel time at all**:

| Case | Reason shown |
|---|---|
| Opposite carriageway | no published crossing on a divided highway |
| Patrol past the incident | a turnaround needs interchange topology we do not have |
| Express | direction is not published |
| Carriageway unresolved | no approach direction to follow |

Straight-line distance is never used as driving distance — it is not computed anywhere in
`patrolRouting.js`, so it cannot leak into a number an operator would read as an ETA.

A consequence worth stating plainly: **many real incidents have no eligible patrol**, usually because
the carriageway is unresolved or every available patrol is downstream. That is the honest answer, and
the UI says so rather than estimating. Ramp topology is the single dataset that would most improve
this feature.

## Determinism

The same `(seed, configVersion, scenarioId, incidentId, anchor instant)` always produces the same
fleet. There is no `Math.random()` and no reference to the wall clock anywhere in the simulation —
`tests/patrolSimulation.test.mjs` pins this by moving `Date.now()` forward a day and asserting the
fleet is unchanged. Selecting the same historical incident next month shows the same scenario it
showed today, which is what makes a screenshot in a client deck stay true.

Changing any value in `patrolConfig.js` means bumping `CONFIG_VERSION`: the version is part of the
seed, so a changed assumption cannot silently keep producing the old positions.

## What this never does

- convert anything into a crash probability or a crash reduction
- claim an ROI or a monetary saving
- touch the Secondary Incident Risk score, Historical Location Safety, Operational Impact,
  historical weather or data confidence — a test asserts the risk engine is unmoved when every
  patrol field is handed to it at once
- call a dispatch API. "Simulate dispatch" is arithmetic over stated assumptions; nothing leaves
  the browser.
