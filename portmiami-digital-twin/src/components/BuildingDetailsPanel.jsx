import { buildingLabel, buildingSourceLabel, buildingTypeLabel } from '../buildings/buildingModel.js';
import { ASSET_CATEGORIES, MERCATOR_NOTE } from '../config/buildings.js';
import { categoryLabel as assetCategoryLabel } from '../infrastructure/assetModel.js';
import { BUILDING_RELATIONSHIPS } from '../infrastructure/assetLinks.js';
import { ASSET_SOURCES, OPERATIONAL_STATUS_LABELS } from '../config/infrastructure.js';

function Row({ label, value, note }) {
  const missing = value === null || value === undefined || value === '';
  return (
    <div className="road-detail-row">
      <dt>{label}</dt>
      <dd className={missing ? 'is-missing' : undefined}>
        {missing ? 'Not available' : value}
        {note && <small>{note}</small>}
      </dd>
    </div>
  );
}

const num = (value, digits = 0) =>
  value == null ? null : value.toLocaleString('en-US', { maximumFractionDigits: digits });

export function BuildingDetailsPanel({ building, linkedAsset, onOpenAsset, onFindAsset, onViewOnMap, onClear }) {
  const [lon, lat] = building.centroid;
  const mercatorFactor = MERCATOR_NOTE.lengthFactorAt(lat);
  const categoryLabel = ASSET_CATEGORIES.find(c => c.id === building.asset?.category)?.label;

  return (
    <aside className="road-details" aria-label="Building details">
      <header className="road-details-head">
        <div>
          <h2>{buildingLabel(building)}</h2>
          <p>{building.geometryType}{building.partCount > 1 && ` · ${building.partCount} parts`}</p>
        </div>
        <button type="button" className="road-icon-btn" onClick={onClear} aria-label="Clear selection">×</button>
      </header>

      <div className="road-details-actions">
        <button type="button" className="road-btn is-primary" onClick={onViewOnMap}>View on map</button>
        <button type="button" className="road-btn" onClick={onClear}>Clear selection</button>
      </div>

      <section>
        <h3>Identity</h3>
        <dl>
          <Row label="OBJECTID" value={building.objectId} />
          <Row
            label="UNIQUEID"
            value={building.uniqueId || null}
            note={building.uniqueId ? 'Not unique across the dataset' : 'Null for 1,574 of the 6,000 features'}
          />
          <Row label="GlobalID" value={building.globalId || null} />
        </dl>
      </section>

      {/* The existing PortMiami Asset section, now fed by the infrastructure registry. */}
      <section>
        <h3>PortMiami asset</h3>
        <dl>
          {linkedAsset ? (
            <>
              <Row label="Asset" value={linkedAsset.asset.name} />
              <Row label="Category" value={assetCategoryLabel(linkedAsset.asset.category)} />
              <Row
                label="Verification"
                value={linkedAsset.asset.verificationStatus}
                note={linkedAsset.asset.verificationStatus === 'VERIFIED'
                  ? 'Name read from an official Miami-Dade source'
                  : 'Backed only by a secondary source'}
              />
              {linkedAsset.asset.operationalStatus && (
                <Row
                  label="Operational status"
                  value={OPERATIONAL_STATUS_LABELS[linkedAsset.asset.operationalStatus.state]
                    ?? linkedAsset.asset.operationalStatus.state}
                  note={linkedAsset.asset.operationalStatus.basis}
                />
              )}
              <Row
                label="Relationship"
                value={BUILDING_RELATIONSHIPS[linkedAsset.link.relationship] ?? linkedAsset.link.relationship}
                note={linkedAsset.link.evidence}
              />
              {/* Where the asset's identity came from. A named terminal on a footprint is only
                  as good as the source that named it, so the source is cited here rather than
                  left behind in the Infrastructure explorer. */}
              {(linkedAsset.asset.sources ?? []).map(id => {
                const source = ASSET_SOURCES[id];
                return source ? (
                  <Row
                    key={id}
                    label="Source"
                    value={<a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>}
                    note={`${source.publisher} · ${source.authority === 'OFFICIAL' ? 'official' : 'secondary'}`
                      + `${source.revised ? ` · revised ${source.revised}` : ''}`
                      + ` · ${linkedAsset.asset.supports?.[id] ?? 'cited for this asset'}`}
                  />
                ) : null;
              })}
            </>
          ) : building.asset ? (
            <>
              <Row label="Asset" value={building.asset.name} />
              <Row label="Category" value={categoryLabel ?? building.asset.category} />
              <Row label="Asset ID" value={building.asset.assetId} />
              <Row label="Stated by" value={building.asset.source} />
            </>
          ) : (
            <Row label="Asset record" value={null} note="No infrastructure asset linked" />
          )}
        </dl>
        <div className="road-details-actions infra-inline-actions">
          {linkedAsset
            ? <button type="button" className="road-btn" onClick={() => onOpenAsset?.(linkedAsset.asset.id)}>
                View infrastructure asset
              </button>
            : <button type="button" className="road-btn" onClick={() => onFindAsset?.()}>
                Find or link asset
              </button>}
        </div>
        {!linkedAsset && !building.asset && (
          <p className="road-note">
            The GIS source carries no building names or functions, so nothing here is inferred from
            footprint size or position. A link is made in the Infrastructure explorer and keyed by
            this OBJECTID.
          </p>
        )}
      </section>

      <section>
        <h3>Geometry</h3>
        <dl>
          <Row label="Type" value={building.geometryType} />
          <Row label="Parts" value={building.partCount} />
          <Row label="Holes" value={building.holeCount} />
          <Row label="Centroid" value={`${lat.toFixed(5)}, ${lon.toFixed(5)}`} note="latitude, longitude of the footprint's extent" />
          <Row
            label="Ground area"
            value={num(building.groundAreaM2) === null ? null : `${num(building.groundAreaM2)} m²`}
            note="computed from the geometry, holes subtracted"
          />
          <Row
            label="Ground perimeter"
            value={num(building.groundPerimeterM) === null ? null : `${num(building.groundPerimeterM)} m`}
            note="computed from the geometry"
          />
        </dl>
      </section>

      <section>
        <h3>Source shape fields</h3>
        <dl>
          <Row label="Shape__Area" value={num(building.sourceArea, 2)} note="Web Mercator square units" />
          <Row label="Shape__Length" value={num(building.sourceLength, 2)} note="Web Mercator units" />
        </dl>
        <p className="road-note">
          Shape__Area and Shape__Length are projected (EPSG:3857) measures, not ground
          measurements: across 5,986 footprints their ratio to the ground figures matches
          1/cos(latitude) to five decimals. At this latitude that is ×{mercatorFactor.toFixed(4)} for
          length and ×{(mercatorFactor ** 2).toFixed(4)} for area, so reading Shape__Area as square
          metres overstates the footprint by about 23%. The ground figures above are computed from
          the geometry instead.
        </p>
      </section>

      <section>
        <h3>Building information</h3>
        <dl>
          <Row
            label="HEIGHT"
            value={building.height}
            note={building.height === null
              ? 'Null for 5,423 of the 6,000 features'
              : 'The source states no unit for this field'}
          />
          <Row label="TYPE" value={building.type ? buildingTypeLabel(building.type) : null} note="code; the file ships no lookup table" />
          <Row label="SOURCE" value={building.source ? buildingSourceLabel(building.source) : null} note="code; the file ships no lookup table" />
          <Row
            label="YEARUPDATE"
            value={building.yearUpdate}
            note="when the source record was last updated — not the construction year"
          />
        </dl>
      </section>
    </aside>
  );
}
