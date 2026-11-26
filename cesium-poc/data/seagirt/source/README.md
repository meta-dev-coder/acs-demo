# Seagirt Marine Terminal — geographic source extracts

Raw extracts the Seagirt map layers are built from (`tools/build-seagirt-data.mjs`). Not shipped
to the browser; the built layers in `public/data/seagirt/` are.

| File | Source | Retrieved | Licence |
|---|---|---|---|
| `osm-seagirt-terminal.json` | Overpass API: way 87334858 (`landuse=industrial`, `name=Seagirt Marine Terminal`) and way 336181714 (`power=substation`, `barrier=fence`) | 2026-11-23 | © OpenStreetMap contributors, ODbL 1.0 |
| `osm-seagirt-bbox.xml` | OpenStreetMap API 0.6 `map?bbox=-76.5545,39.2500,-76.5360,39.2650` | 2026-11-23 | © OpenStreetMap contributors, ODbL 1.0 |

What these are NOT: a surveyed terminal boundary, or any part of the terminal's electrical network.
The terminal outline is community-mapped land use. OpenStreetMap maps no cranes here. The one mapped
substation has no owner, voltage or equipment recorded. `tools/build-seagirt-data.mjs` records it in
`public/data/seagirt/gis-associations.json` as a CANDIDATE (unverified) location for the illustrative
Substation SS1, with the evidence for and against. That is a display association only: public GIS
does not hold the terminal's private electrical network.
