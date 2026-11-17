/**
 * The Facility tab: everything the county publishes about a facility beyond its identity.
 *
 * For a garage or lot that is the clearance, the rate schedule, the contact and the reservation
 * link; for a cruise terminal it is size, certification and dates. The port-wide parking rules —
 * payment, hours, accessibility, shuttle, security — are shown once, under their own heading,
 * rather than copied onto every garage.
 *
 * The rule the whole panel follows: **a field the source does not publish is shown as not
 * published, not hidden.** Capacity, EV charging, valet and car rental are the things people
 * actually go looking for, and the county parking page carries none of them; saying so is an
 * answer, and silence would read as "we didn't bother".
 */
import { PARKING_POLICIES, PARKING_RATES } from '../config/infrastructure.js';

function Row({ label, value, note }) {
  const missing = value === null || value === undefined || value === '';
  return (
    <div className="road-detail-row">
      <dt>{label}</dt>
      <dd className={missing ? 'is-missing' : undefined}>
        {missing ? 'Not published' : value}
        {note && <small>{note}</small>}
      </dd>
    </div>
  );
}

const number = value => (Number.isFinite(value) ? value.toLocaleString('en-US') : null);

function Rates({ scheduleId, note }) {
  const schedule = scheduleId ? PARKING_RATES[scheduleId] : null;
  if (!schedule || schedule.lines.length === 0) {
    return (
      <p className="road-note">
        {note ?? (schedule
          ? `Rates are ${schedule.appliesToText.toLowerCase()}.`
          : 'The county page publishes no rate schedule for this facility.')}
      </p>
    );
  }
  return (
    <>
      <ul className="infra-rate-list">
        {schedule.lines.map(line => (
          <li key={line.label}>
            <span>{line.label}</span>
            <strong>{line.amount}</strong>
            {line.effective && <small>Effective {line.effective}</small>}
          </li>
        ))}
      </ul>
      <p className="road-note">Published as applying to: {schedule.appliesToText}.</p>
    </>
  );
}

function ParkingFacility({ asset }) {
  const a = asset.attributes;
  const clearance = a.clearance;
  return (
    <>
      <h3>Clearance</h3>
      {clearance?.openAir ? (
        <p className="road-note">
          Open lot with no overhead clearance, so no height restriction applies. That is different
          from a clearance the county has not published.
        </p>
      ) : clearance ? (
        <>
          <dl>
            <Row label="First floor" value={clearance.firstFloor} />
            <Row label="Second floor" value={clearance.secondFloor} />
            <Row label="Remaining floors" value={clearance.remainingFloors} />
            <Row
              label="Lowest posted"
              value={clearance.lowestInches
                ? `${Math.floor(clearance.lowestInches / 12)}' ${clearance.lowestInches % 12}"`
                : null}
              note="The lowest of the floors the county lists — the height that decides whether a vehicle can use the garage at all"
            />
          </dl>
          {!clearance.firstFloor && (
            <p className="road-note">The county&rsquo;s table lists no first-floor clearance for this garage.</p>
          )}
        </>
      ) : (
        <p className="road-note">The county page publishes no clearance for this facility.</p>
      )}

      <h3 className="infra-sub">Rates</h3>
      <Rates scheduleId={a.rateScheduleId} note={a.ratesNote} />

      {a.oversizedVehicles && (
        <>
          <h3 className="infra-sub">Oversized vehicles</h3>
          <p className="road-note">{a.oversizedVehicles.accepted} {a.oversizedVehicles.note}</p>
          <Rates scheduleId={a.oversizedVehicles.rates} />
          <dl>
            <Row
              label="Help parking an oversized vehicle"
              value={a.oversizedVehicles.phones.join(' or ')}
            />
          </dl>
        </>
      )}

      <h3 className="infra-sub">Reservations and contact</h3>
      <dl>
        <Row
          label="Reservations"
          value={a.reservations
            ? <a href={a.reservations.url} target="_blank" rel="noopener noreferrer">{a.reservations.operator}</a>
            : null}
          note={a.reservations
            ? 'Run by the garage operator, not by the county'
            : 'The county page offers no reservation link for this facility'}
        />
        <Row label="Telephone" value={a.phone} note={a.phoneNote} />
        <Row label="Operator note" value={a.operatorNote} />
      </dl>
    </>
  );
}

function TerminalFacility({ asset }) {
  const f = asset.attributes.facility ?? {};
  const hasAny = Object.keys(f).length > 0;
  return (
    <>
      <h3>Facility</h3>
      <dl>
        <Row
          label="Floor area"
          value={number(f.floorAreaSqFt) ? `${number(f.floorAreaSqFt)} sq ft` : null}
          note={f.floorAreaSqFt ? 'As stated by the county' : null}
        />
        {/* Shown as a combined figure on purpose. The county quotes 471,000 sq ft for D, E and F
            together; printing it on each would treble the real area. */}
        <Row
          label="Combined floor area"
          value={number(f.combinedFloorAreaSqFt) ? `${number(f.combinedFloorAreaSqFt)} sq ft` : null}
          note={f.combinedWith ? `The county states this figure for ${f.combinedWith}, not for this terminal alone` : null}
        />
        <Row label="Levels" value={f.levels} />
        <Row label="Ships" value={f.ships} />
        <Row label="Role" value={f.role} />
        <Row label="LEED certification" value={f.leed} />
        <Row label="Opened" value={f.opened} />
        <Row label="Expanded" value={f.expanded} />
        <Row label="Renovated" value={f.renovated} />
        <Row label="Construction from" value={f.constructionFrom} />
        <Row label="Opening expected" value={f.openingExpected} />
      </dl>
      {!hasAny && (
        <p className="road-note">
          The county terminals page names this terminal but publishes no size, certification or date for it.
        </p>
      )}
      <p className="road-note">
        Berth count, ship capacity and passenger throughput are not published by either source read.
      </p>
    </>
  );
}

/** The parking rules that apply everywhere, shown once rather than copied onto each garage. */
function PortWideParking() {
  const p = PARKING_POLICIES;
  return (
    <>
      <h3 className="infra-sub">Rules that apply at every facility</h3>
      <dl>
        <Row label="Payment accepted" value={p.payment.accepted.join(', ')} />
        <Row
          label="Not accepted"
          value={p.payment.notAccepted.join(', ')}
          note="Worth knowing before the exit barrier"
        />
        <Row label="Hours on cruise days" value={p.hours.cruiseDays} />
        <Row label="Non-cruise days" value={p.hours.nonCruiseDays} note={p.hours.nonCruiseDaysPhone} />
        <Row label="Shuttle" value={p.shuttle.available} note="The page names no operator, route or schedule" />
        <Row label="Security" value={p.security} />
        <Row label="Disabled parking" value={p.accessibility.designatedSpaces} />
        <Row label="Complimentary time" value={p.accessibility.complimentary} />
      </dl>
      <ul className="infra-note-list">
        {p.accessibility.statutoryExemptions.map(line => <li key={line}>{line}</li>)}
      </ul>
      <p className="road-note">
        <a href={p.disputes.url} target="_blank" rel="noopener noreferrer">Dispute a parking transaction</a>
        {' · '}
        <a href={p.garageMapUrl} target="_blank" rel="noopener noreferrer">County garage map (PDF)</a>
      </p>

      <h3 className="infra-sub">Not published by the county parking page</h3>
      <ul className="infra-note-list">
        {p.notPublished.map(line => <li key={line}>{line}</li>)}
      </ul>
    </>
  );
}

/** Whether an asset has anything to show on this tab. */
export const hasFacilityDetail = asset => asset?.category === 'PARKING'
  || (asset?.category === 'CRUISE_TERMINAL');

export function AssetFacilityTab({ asset }) {
  return (
    <section>
      {asset.category === 'PARKING' ? <ParkingFacility asset={asset} /> : <TerminalFacility asset={asset} />}
      {asset.category === 'PARKING' && <PortWideParking />}
    </section>
  );
}
