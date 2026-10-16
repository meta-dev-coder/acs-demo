/**
 * The Safety Intelligence screen's own marks.
 *
 * TWO STATES, because one mark per finding made the corridor unreadable: 19 circles, 190 diamonds
 * and a replay dot each, all at once.
 *
 *   • COLLAPSED — one numbered badge per place, on a stem, in the Agency screen's own crash-hotspot
 *     style so the two screens read as one corridor. The number is how many findings are gathered
 *     there across all four domains.
 *   • OPENED — choosing a badge draws that place's members individually: each incident record, open
 *     work order and hazard location as its own mark, with the badge kept as the place's anchor.
 *     Every other place stays a badge, so the rest of the corridor does not come back as clutter.
 *
 * A REPLAY RECORD is a plain dot, drawn only while the replay bar is open.
 *
 * Every position on this layer is asset-derived or register-derived — none of it is surveyed crash
 * geometry — and the circle's label says the radius so the reader can see how coarse it is.
 *
 * Added on activate, removed on leave: no other workspace inherits these marks.
 */
import { Cartesian2, Cartesian3, Color, CustomDataSource, DistanceDisplayCondition, HeightReference,
  LabelStyle, NearFarScalar, ScreenSpaceEventType, VerticalOrigin } from 'cesium';

import { DOMAIN_TONES } from './tones.js';
import { assetPinMarker, crashCountMarker } from '../assetIdMarker.js';
import { WORKSPACE_ICONS } from '../workspaceStrip.js';
import { leaderLine } from '../tmc/tmcMapMarkers.js';
import { membersOf } from './analytics/mapPlaces.js';

export { DOMAIN_TONES };

const diamond = (fill, selected) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24">
    <path d="M12 2 22 12 12 22 2 12z" fill="${fill}" stroke="${selected ? '#ffffff' : '#0b1729'}"
      stroke-width="${selected ? 3 : 1.6}"/>
  </svg>`)}`;

/**
 * The mark for the one incident that is SELECTED.
 *
 * A plain dot was lost the moment a counted badge stood over it. This is a white ring with a
 * coloured core and a drop shadow — it reads against photogrammetry, against the section ribbon and
 * against the badges, and it is the only ring on the layer, so nothing else can be mistaken for it.
 */
const selectedRing = fill => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="176" height="176" viewBox="0 0 44 44">
    <circle cx="22" cy="22" r="19" fill="none" stroke="#0b1729" stroke-width="7" opacity="0.55"/>
    <circle cx="22" cy="22" r="19" fill="none" stroke="#ffffff" stroke-width="4"/>
    <circle cx="22" cy="22" r="12" fill="none" stroke="${fill}" stroke-width="4"/>
    <circle cx="22" cy="22" r="5" fill="${fill}" stroke="#ffffff" stroke-width="1.6"/>
  </svg>`)}`;

/** A patrol vehicle. Chevron in a disc, so it is not mistaken for a finding. */
const patrolIcon = (fill, available) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="104" height="104" viewBox="0 0 26 26">
    <circle cx="13" cy="13" r="11" fill="${fill}" stroke="#0b1729" stroke-width="2"
      opacity="${available ? 1 : 0.55}"/>
    <path d="M7 16.5 13 7l6 9.5-6-3z" fill="#0b1729" opacity="0.85"/>
  </svg>`)}`;

const dot = (fill, severe) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 16 16">
    <circle cx="8" cy="8" r="${severe ? 6 : 4.5}" fill="${fill}" stroke="#0b1729" stroke-width="1.4"/>
  </svg>`)}`;

const VISIBLE_TO_M = 90_000;
/**
 * Stem lengths in SCREEN pixels, laddered over three rungs — the Agency screen's own figures, so
 * the two screens' badges stand off their road the same way.
 */
const LEADER_BASE_PX = 26;
const LEADER_RUNG_PX = 46;
const LEADER_RUNGS = 3;

/**
 * @param {import('cesium').Viewer} viewer
 */
export function installSafetyMapLayer(viewer) {
  const source = new CustomDataSource('I-595 Safety Intelligence');
  const added = viewer ? viewer.dataSources.add(source) : Promise.resolve();
  /** entity id -> what it stands for, so a click can report a domain object rather than a pixel. */
  const byId = new Map();
  let selectedId = null;
  let report = null;
  /**
   * Where the camera was before the screen moved it.
   *
   * Investigation moves the camera constantly — a section, then a record in it, then an asset
   * beside it — and an operator who has framed a view by hand should be able to get it back. Saved
   * on the FIRST programmatic move of a sequence and kept until it is used.
   */
  let parkedCamera = null;

  const clear = kind => {
    for (const [id, mark] of [...byId]) {
      if (mark.kind !== kind) continue;
      source.entities.removeById(id);
      byId.delete(id);
    }
  };

  /**
   * Draw the places, collapsed.
   *
   * The stem is laddered in screen pixels — three rungs, as the Agency screen does it — so two
   * badges near each other on the ground still clear one another on screen at every zoom.
   */
  function setPlaces(places = [], { openedId = null } = {}) {
    clear('place');
    clear('member');
    places.forEach((place, index) => {
      if (!Number.isFinite(place.longitude)) return;
      // An OPENED place loses its badge entirely. The count was the invitation to look; once it has
      // been taken, the findings themselves are on screen and the number sitting on top of them is
      // just a disc over the thing it was pointing at.
      if (place.id === openedId) return;
      const id = `place:${place.id}`;
      byId.set(id, { kind: 'place', place });
      const marker = crashCountMarker({
        count: place.count,
        color: place.band.color,
        stem: LEADER_BASE_PX + (index % LEADER_RUNGS) * LEADER_RUNG_PX,
      });
      source.entities.add({
        id,
        name: `${place.label} — ${place.count} ${place.noun ?? 'findings'}`,
        position: Cartesian3.fromDegrees(place.longitude, place.latitude),
        billboard: {
          image: marker.image, width: marker.width, height: marker.height,
          verticalOrigin: VerticalOrigin.BOTTOM,
          // Never hidden behind a building: a number the operator cannot see is a number they will
          // never know was there.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new DistanceDisplayCondition(0, VISIBLE_TO_M),
        },
      });
    });
    if (openedId) {
      const place = places.find(entry => entry.id === openedId);
      if (place) drawMembers(place);
    }
    viewer?.scene?.requestRender?.();
  }


  /**
   * One mark per finding inside the opened place.
   *
   * Three shapes, so a record, a defect and a hazard can never be mistaken for one another, and
   * each carries its own label at close range.
   */
  function drawMembers(place) {
    const members = membersOf(place);
    // Several historical records can inherit the same damaged asset coordinates. Give each one a
    // different TMC-style leader height so expanding a badge labelled 10 visibly produces ten
    // pointed pins while every line still terminates at the record's true mapped location.
    const incidentSlots = new Map();
    for (const member of members.filter(entry => entry.kind === 'incident'
      && Number.isFinite(entry.longitude) && Number.isFinite(entry.latitude))) {
      const key = `${member.longitude.toFixed(6)}:${member.latitude.toFixed(6)}`;
      if (!incidentSlots.has(key)) incidentSlots.set(key, []);
      incidentSlots.get(key).push(member.id);
    }
    for (const member of members) {
      if (!Number.isFinite(member.longitude)) continue;
      const id = `member:${member.kind}:${member.id}`;
      byId.set(id, { kind: 'member', member, place });
      const incident = member.kind === 'incident';
      const slots = incident
        ? incidentSlots.get(`${member.longitude.toFixed(6)}:${member.latitude.toFixed(6)}`) ?? [] : [];
      const slot = Math.max(0, slots.indexOf(member.id));
      const severe = member.item.severity?.level === 'FATAL';
      const injured = member.item.severity?.level === 'INJURY';
      const color = severe ? '#E5484D' : injured ? '#F4A725' : '#3B82F6';
      const stem = 34 + slot * 24;
      const marker = incident ? assetPinMarker({
        color, glyphSvg: WORKSPACE_ICONS.incident, key: `safety-history:${color}`, size: 0.8,
      }) : null;
      if (incident) {
        const line = leaderLine({ height: stem, color: `${color}aa` });
        const leaderId = `member-leader:${member.kind}:${member.id}`;
        byId.set(leaderId, { kind: 'member', member, place, targetId: id });
        source.entities.add({
          id: leaderId,
          name: member.label,
          position: Cartesian3.fromDegrees(member.longitude, member.latitude),
          billboard: {
            image: line.image, width: line.width, height: line.height,
            verticalOrigin: VerticalOrigin.BOTTOM,
            heightReference: HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new DistanceDisplayCondition(0, VISIBLE_TO_M),
          },
        });
      }
      source.entities.add({
        id,
        name: member.label,
        position: Cartesian3.fromDegrees(member.longitude, member.latitude),
        billboard: {
          image: incident
            ? marker.image
            : diamond(member.kind === 'defect' ? DOMAIN_TONES.ASSET : DOMAIN_TONES.HAZARD, false),
          width: incident ? marker.width : 20, height: incident ? marker.height : 20,
          verticalOrigin: incident ? VerticalOrigin.BOTTOM : VerticalOrigin.CENTER,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new DistanceDisplayCondition(0, VISIBLE_TO_M),
          pixelOffset: incident ? new Cartesian2(0, -stem) : new Cartesian2(0, 0),
        },
        // No standing label. Forty findings inside 230 m put forty labels on top of each other and
        // the place became a block of overlapping text. The name belongs to the mark the operator
        // has actually chosen — see `highlight` — and to the list in the panel beside the map.
        label: {
          text: member.label,
          font: '500 11px Inter, system-ui, sans-serif',
          fillColor: Color.WHITE, outlineColor: Color.fromCssColorString('#0b1729'),
          outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, -16),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          show: false,
        },
      });
    }
  }

  /**
   * Draw the replay frame: the records lit at the cursor.
   *
   * Rebuilt per frame. The frames are small (tens of records), so a rebuild is cheaper than
   * diffing and cannot leave a stale dot behind.
   */
  function setReplayFrame(facts) {
    clear('replay');
    for (const fact of facts ?? []) {
      if (!Number.isFinite(fact.longitude) || !Number.isFinite(fact.latitude)) continue;
      const id = `replay:${fact.id}`;
      if (byId.has(id)) continue;
      byId.set(id, { kind: 'replay', fact });
      source.entities.add({
        id,
        name: `${fact.type} · ${fact.severity.label}`,
        position: Cartesian3.fromDegrees(fact.longitude, fact.latitude),
        billboard: {
          image: dot(fact.severity.level === 'FATAL' ? '#E5484D'
            : fact.severity.level === 'INJURY' ? '#F4A725' : '#94A3B8', fact.severity.rank >= 2),
          width: 16, height: 16, verticalOrigin: VerticalOrigin.CENTER,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new DistanceDisplayCondition(0, VISIBLE_TO_M),
          pixelOffset: new Cartesian2(0, 0),
        },
      });
    }
    viewer?.scene?.requestRender?.();
  }

  /**
   * Ring the chosen member, so the map and the panel agree about what is selected.
   *
   * The opened PLACE is not ringed here — `setPlaces` already redraws its badge white and in place
   * of its stem, which reads at any zoom.
   */
  function highlight(id) {
    const next = id == null ? null : String(id);
    if (next === selectedId) return;
    for (const key of [selectedId, next]) {
      const mark = key && byId.get(key);
      const entity = key && source.entities.getById(key);
      if (!mark || !entity || mark.kind !== 'member') continue;
      const on = key === next;
      const incident = mark.member.kind === 'incident';
      if (incident) {
        const severe = mark.member.item.severity?.level === 'FATAL';
        const injured = mark.member.item.severity?.level === 'INJURY';
        const color = severe ? '#E5484D' : injured ? '#F4A725' : '#3B82F6';
        const marker = assetPinMarker({
          color, glyphSvg: WORKSPACE_ICONS.incident,
          key: `safety-history:${color}`, size: 0.8, selected: on,
        });
        entity.billboard.image = marker.image;
        entity.billboard.width = marker.width;
        entity.billboard.height = marker.height;
      } else {
        entity.billboard.width = on ? 28 : 20;
        entity.billboard.height = on ? 28 : 20;
      }
      // Only the chosen mark is named, so one label is readable where forty were not.
      if (entity.label) entity.label.show = on;
    }
    selectedId = next;
    viewer?.scene?.requestRender?.();
  }

  const handler = viewer?.screenSpaceEventHandler ?? null;
  const previousClick = handler?.getInputAction(ScreenSpaceEventType.LEFT_CLICK) ?? null;
  if (handler) {
    handler.setInputAction(movement => {
      // The entity is `pick().id`; the identifier is the entity's own `id`.
      const entity = viewer.scene.pick(movement.position)?.id;
      const id = entity?.id != null ? String(entity.id) : null;
      const mark = id && byId.get(id);
      if (mark) report?.(mark.targetId ?? id, mark); else previousClick?.(movement);
    }, ScreenSpaceEventType.LEFT_CLICK);
  }

  /**
   * Draw the selected corridor section.
   *
   * A polyline on the ground along the section's own centreline, not a box: the selection IS a
   * stretch of road, and a rectangle around it would claim an area the data does not describe.
   * Drawn under everything else so the markers stay readable on top of it.
   */
  function setSection(section, { stretch = null } = {}) {
    clear('section');
    // The stretch the findings actually occupy, where one could be derived; otherwise the whole
    // milepost range. Lighting four miles of road for 25 records gathered in 300 m of it says the
    // wrong thing about where to look.
    const lines = stretch?.lines ?? section?.lines;
    if (!lines?.length) { viewer?.scene?.requestRender?.(); return; }
    lines.forEach((line, index) => {
      const id = `section:${section.id}:${index}`;
      byId.set(id, { kind: 'section', section });
      source.entities.add({
        id,
        name: stretch ? `${section.label} — ${stretch.metres} m` : section.label,
        polyline: {
          positions: line.map(([longitude, latitude]) => Cartesian3.fromDegrees(longitude, latitude)),
          // A derived stretch is drawn heavier: it is a claim about where the findings are, and it
          // has to read against the badges standing over it.
          width: stretch ? 20 : 14,
          material: Color.fromCssColorString('#67F4E2').withAlpha(stretch ? 0.55 : 0.42),
          clampToGround: true,
        },
      });
    });
    viewer?.scene?.requestRender?.();
  }

  /** The one record that is open, told apart from the others around it. */
  function setSelectedRecord(fact) {
    clear('record');
    if (!fact || !Number.isFinite(fact.longitude)) { viewer?.scene?.requestRender?.(); return; }
    const position = Cartesian3.fromDegrees(fact.longitude, fact.latitude);
    const tone = fact.severity.level === 'FATAL' ? '#E5484D'
      : fact.severity.level === 'INJURY' ? '#F4A725' : '#67F4E2';

    // A halo on the ground, so the selection is findable from the corridor view where a billboard
    // is a few pixels across and sits among a dozen badges.
    const haloId = `record:${fact.id}:halo`;
    byId.set(haloId, { kind: 'record', fact });
    source.entities.add({
      id: haloId,
      position,
      ellipse: {
        semiMinorAxis: 90, semiMajorAxis: 90,
        material: Color.fromCssColorString(tone).withAlpha(0.2),
        outline: true, outlineColor: Color.WHITE.withAlpha(0.85), outlineWidth: 2,
        heightReference: HeightReference.CLAMP_TO_GROUND,
      },
    });

    const id = `record:${fact.id}`;
    byId.set(id, { kind: 'record', fact });
    source.entities.add({
      id,
      name: `${fact.type} · ${fact.severity.label}`,
      position,
      billboard: {
        image: selectedRing(tone),
        width: 44, height: 44, verticalOrigin: VerticalOrigin.CENTER,
        // Never behind terrain, a building or another mark: the selection is the one thing on this
        // layer the operator is looking for.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new NearFarScalar(400, 1.15, 40_000, 0.75),
      },
      // No label. The member pin for this same record carries the name, and writing it here too
      // put the same text on the map twice, overlapping itself. The ring and halo are the
      // highlight; the pin is the label.
    });
    viewer?.scene?.requestRender?.();
  }

  /**
   * The modelled queue, drawn on the road behind the incident.
   *
   * Amber and translucent, with its own label saying it is simulated — this is the one overlay on
   * the screen that depicts something that never happened, and it must never be mistaken for the
   * record of one. Cleared the moment the Lab is left.
   */
  function setSimulatedQueue(coordinates, { label = 'Modelled queue' } = {}) {
    clear('queue');
    if (!coordinates?.length) { viewer?.scene?.requestRender?.(); return; }
    const id = 'queue:modelled';
    byId.set(id, { kind: 'queue' });
    source.entities.add({
      id,
      name: `${label} — simulated, not observed`,
      polyline: {
        positions: coordinates.map(([longitude, latitude]) => Cartesian3.fromDegrees(longitude, latitude)),
        width: 22,
        material: Color.fromCssColorString('#F4A725').withAlpha(0.5),
        clampToGround: true,
      },
    });
    viewer?.scene?.requestRender?.();
  }

  /**
   * The simulated patrol fleet, each one labelled with how long it would take to reach the incident.
   *
   * Drawn only while the Patrols tab is open — six more marks on a corridor that already carries
   * badges would be clutter everywhere else — and every label carries SIM in its name, because a
   * vehicle drawn on a map reads as a vehicle that is there.
   */
  function setPatrols(patrols, { incident = null, recommendedId = null } = {}) {
    clear('patrol');
    if (!patrols?.length) { viewer?.scene?.requestRender?.(); return; }
    patrols.forEach((patrol, index) => {
      if (!Number.isFinite(patrol.longitude)) return;
      const recommended = patrol.id === recommendedId;
      const id = `patrol:${patrol.id}`;
      byId.set(id, { kind: 'patrol', patrol });
      const position = Cartesian3.fromDegrees(patrol.longitude, patrol.latitude);
      source.entities.add({
        id,
        name: `${patrol.id} · ${patrol.statusLabel} (simulated)`,
        position,
        billboard: {
          image: patrolIcon(patrol.colour, patrol.dispatchable),
          width: 26, height: 26, verticalOrigin: VerticalOrigin.CENTER,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new DistanceDisplayCondition(0, VISIBLE_TO_M),
        },
        label: {
          // The travel time is the point of drawing them at all, so it is on the mark rather than
          // only in the table.
          text: patrol.dispatchable
            ? `${recommended ? '\u2605 SEND ' : ''}${patrol.id} · ${patrol.travelMinutes} min`
            : `${patrol.id} · ${patrol.statusLabel}`,
          font: `${recommended ? '700 12px' : '600 11px'} Inter, system-ui, sans-serif`,
          // Dark ink on a bright plate for the recommended one. A dark green plate with white text
          // was the same reading weight as the navy ones against photogrammetry — the plate has to
          // invert to be seen as different at a glance, not just be a different dark colour.
          fillColor: Color.fromCssColorString(recommended ? '#042f14'
            : patrol.dispatchable ? '#ffffff' : '#c3ccd8'),
          // A filled plate, not an outline. White text outlined in navy still disappeared into
          // bright photogrammetry, and two labels crossing each other were unreadable at any size.
          showBackground: true,
          backgroundColor: Color.fromCssColorString(recommended ? '#22c55e' : '#0b1729')
            .withAlpha(recommended ? 0.96 : 0.88),
          backgroundPadding: new Cartesian2(7, 5),
          style: LabelStyle.FILL,
          verticalOrigin: VerticalOrigin.BOTTOM,
          // Staggered by index: six plates along one corridor otherwise land on top of each
          // other. The recommended one always takes the nearest tier, so the plate that matters is
          // never the one another plate covers.
          pixelOffset: new Cartesian2(0, recommended ? -18 : -18 - (index % 3) * 17),
          // Above its neighbours where they still overlap.
          eyeOffset: recommended ? new Cartesian3(0, 0, -12) : Cartesian3.ZERO,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new DistanceDisplayCondition(0, 40_000),
        },
      });
      // A line from each available patrol to the incident: the travel time is about THIS distance,
      // and a number on a vehicle with no line to anywhere does not say what it is a time to.
      if (patrol.dispatchable && incident && Number.isFinite(incident.longitude)) {
        const lineId = `patrol:${patrol.id}:line`;
        byId.set(lineId, { kind: 'patrol', patrol });
        source.entities.add({
          id: lineId,
          polyline: {
            positions: [position, Cartesian3.fromDegrees(incident.longitude, incident.latitude)],
            width: 2,
            material: Color.fromCssColorString(patrol.colour).withAlpha(0.45),
            clampToGround: true,
          },
        });
      }
    });
    viewer?.scene?.requestRender?.();
  }

  /** Remember where the camera is, unless something is already remembered. */
  function parkCamera() {
    if (parkedCamera || !viewer) return;
    const { camera } = viewer;
    parkedCamera = {
      destination: camera.position.clone(),
      orientation: { heading: camera.heading, pitch: camera.pitch, roll: camera.roll },
    };
  }

  return {
    whenReady: () => added,
    setPlaces,
    setPatrols,
    setSection,
    setSimulatedQueue,
    setSelectedRecord,
    parkCamera,
    get hasParkedCamera() { return Boolean(parkedCamera); },
    /** Put the operator back where they were before the screen started moving the camera. */
    restoreCamera() {
      if (!parkedCamera || !viewer) return false;
      viewer.camera.flyTo({ ...parkedCamera, duration: 1.2 });
      parkedCamera = null;
      return true;
    },
    setReplayFrame,
    highlight,
    markOf: id => byId.get(String(id)) ?? null,
    /** @param {(id: string, mark: object) => void} callback */
    onSelection(callback) { report = callback; },
    clearAll() {
      source.entities.removeAll();
      byId.clear();
      selectedId = null;
      viewer?.scene?.requestRender?.();
    },
    destroy() {
      if (handler) {
        if (previousClick) handler.setInputAction(previousClick, ScreenSpaceEventType.LEFT_CLICK);
        else handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
      }
      viewer?.dataSources?.remove(source, true);
    },
  };
}
