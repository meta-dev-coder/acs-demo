/**
 * What is upstream of an incident — the road traffic is arriving from.
 *
 * This is the part a secondary incident actually depends on: drivers who cannot yet see the
 * incident are approaching it from upstream, and whatever is happening there (a queue, a warning
 * sign, a camera) is what decides whether they arrive safely.
 *
 * Upstream is a question about TRAVEL ORDER, not distance. A point 500 m away on the far
 * carriageway, or 500 m past the incident, is not upstream of anything. So this walks the
 * corridor's own section ordering, in the direction the classifier resolved, and nothing else.
 *
 * Where direction cannot be established the answer is UNRESOLVED and the risk engine scores
 * nothing from it. Express direction is never inferred — not from the time of day, not from
 * anything else — because the Express lanes reverse and the corridor's own section model does not
 * cover them (see server/corridorSections.mjs).
 *
 * Pure: an incident and the corridor's sections in, an upstream description out.
 */
import { CARRIAGEWAYS } from '../liveOps/carriagewayModel.js';

/** Why upstream could or could not be worked out. */
export const UPSTREAM_STATUS = Object.freeze({
  RESOLVED: 'RESOLVED',
  UNRESOLVED: 'UNRESOLVED',
});

/** How many sections upstream count as "approaching" for the risk picture. */
export const UPSTREAM_SECTION_REACH = 2;

/**
 * Which way section indices run against travel.
 *
 * The authoritative field is the corridor's own `travel_order`, and it does NOT follow the section
 * index on both carriageways. Measured on the shipped FDOT geometry:
 *
 *   EB  index 1..8  travel_order 1..8   (west to east — travel runs WITH the index)
 *   WB  index 1..8  travel_order 8..1   (same geometry — travel runs AGAINST the index)
 *
 * Both carriageways are published west-to-east, so westbound traffic arrives from the HIGHER index.
 * Where the sections carry travelOrder this reads it directly; the per-carriageway rule below is
 * the same fact expressed for section models that do not carry it.
 */
export const upstreamStep = carriageway => {
  if (carriageway === CARRIAGEWAYS.EB_GENERAL) return -1;
  if (carriageway === CARRIAGEWAYS.WB_GENERAL) return +1;
  return 0;
};

/** Upstream is simply the lower travel order: one step back along the way traffic came. */
const byTravelOrder = (sections, mine, reach) => {
  const order = Number(mine.travelOrder);
  const found = [];
  for (let n = 1; n <= reach; n++) {
    const section = sections.find(entry => Number(entry.travelOrder) === order - n);
    if (!section) break;
    found.push(section);
  }
  return found;
};

/**
 * The sections upstream of an incident, nearest first.
 *
 * @param {{carriageway: string, sectionIndex: number|null}} incident
 * @param {{sectionId: string, sectionIndex: number, sectionLabel: string, carriageway: string}[]} sections
 * @param {{reach?: number}} [options]
 * @returns {{status: string, reason: string|null, carriageway: string,
 *            sections: object[], sectionIds: string[]}}
 */
export function upstreamSections(incident, sections, { reach = UPSTREAM_SECTION_REACH } = {}) {
  const carriageway = incident?.carriageway ?? CARRIAGEWAYS.UNKNOWN;
  const unresolved = reason => ({ status: UPSTREAM_STATUS.UNRESOLVED, reason, carriageway, sections: [], sectionIds: [] });

  // Express reverses and has no section model of its own; inferring its direction would be making
  // the safety claim up. Unknown means the classifier could not place the event at all.
  if (carriageway === CARRIAGEWAYS.EXPRESS) return unresolved('Express direction is not published');
  if (carriageway === CARRIAGEWAYS.UNKNOWN) return unresolved('Carriageway unresolved');
  if (!Number.isFinite(incident?.sectionIndex)) return unresolved('Section unresolved');

  const step = upstreamStep(carriageway);
  if (step === 0) return unresolved('No travel direction for this carriageway');

  const mine = (sections ?? []).filter(section => section.carriageway === carriageway);
  const here = mine.find(section => section.sectionIndex === incident.sectionIndex);
  if (!here) return unresolved('Section not found on this carriageway');

  // Prefer the corridor's own travel order where the section model carries it; fall back to the
  // index rule, which is the same measured fact for models that do not.
  const found = Number.isFinite(Number(here.travelOrder))
    ? byTravelOrder(mine, here, reach)
    : (() => {
      const walked = [];
      for (let n = 1; n <= reach; n++) {
        const section = mine.find(entry => entry.sectionIndex === incident.sectionIndex + step * n);
        if (!section) break;   // the corridor ends; nothing beyond it is upstream
        walked.push(section);
      }
      return walked;
    })();
  return {
    status: UPSTREAM_STATUS.RESOLVED,
    reason: null,
    carriageway,
    sections: found,
    sectionIds: found.map(section => section.sectionId),
  };
}

/**
 * Whether a live event sits upstream of an incident.
 *
 * Same carriageway, and within the upstream sections — never a radius. An event on the opposite
 * carriageway is not upstream however close it is, which is the whole reason this is not a
 * distance test.
 */
export function isUpstreamOf(event, incident, upstream) {
  if (upstream?.status !== UPSTREAM_STATUS.RESOLVED) return false;
  const ops = event?.liveOps ?? {};
  if (ops.carriageway !== incident.carriageway) return false;
  return upstream.sectionIds.includes(ops.sectionId);
}

/**
 * How far upstream a resource is, along the corridor, or null when that cannot be said.
 *
 * Uses the corridor position both already carry (`offsetM` from corridorPositionOf). A negative
 * result means the resource is DOWNSTREAM — past the incident — and callers drop it rather than
 * reporting a distance that points the wrong way.
 */
export function upstreamOffsetM(incidentOffsetM, resourceOffsetM, carriageway) {
  if (!Number.isFinite(incidentOffsetM) || !Number.isFinite(resourceOffsetM)) return null;
  const step = upstreamStep(carriageway);
  if (step === 0) return null;
  // Eastbound traffic comes from the lower offset, so upstream is incident − resource.
  return step === -1 ? incidentOffsetM - resourceOffsetM : resourceOffsetM - incidentOffsetM;
}
