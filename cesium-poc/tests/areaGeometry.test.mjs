/**
 * The rectangle predicates behind Ask the Twin's area selection.
 *
 * The corridor's own geometry is used wherever a real shape makes the point better than a made-up
 * one: the FDOT segment LineStrings and the express geometry are what the feature actually has to
 * intersect, and a box drawn over them either finds them or does not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  boundsCenter, boundsFromCorners, boundsSizeMetres, boundsToPolygon, geometryIntersectsBounds,
  isUsableBounds, lineStringIntersectsBounds, pointInBounds, polygonIntersectsBounds, segmentIntersectsBounds,
} from '../src/spatial/areaGeometry.js';

const read = async name => JSON.parse(await readFile(fileURLToPath(new URL(`../public/data/${name}`, import.meta.url)), 'utf8'));
const segments = await read('i595_fdot_traffic_segments.geojson');
const express = await read('express-way.geojson');

/** A small box over the corridor near SW 136th Ave, where EB, WB and Express all run together. */
const CORRIDOR_BOX = { west: -80.256, south: 26.095, east: -80.248, north: 26.103 };

test('two dragged corners become a box, whichever way round they were dragged', () => {
  const a = { longitude: -80.25, latitude: 26.10 }, b = { longitude: -80.30, latitude: 26.05 };
  const expected = { west: -80.30, south: 26.05, east: -80.25, north: 26.10 };
  assert.deepEqual(boundsFromCorners(a, b), expected);
  assert.deepEqual(boundsFromCorners(b, a), expected, 'dragging up-left is the same box as down-right');
});

test('a drag that never reached the globe has no box, and a click is not an area', () => {
  assert.equal(boundsFromCorners(null, { longitude: -80.2, latitude: 26.1 }), null);
  assert.equal(boundsFromCorners({ longitude: NaN, latitude: 26.1 }, { longitude: -80.2, latitude: 26.1 }), null);
  const point = boundsFromCorners({ longitude: -80.2, latitude: 26.1 }, { longitude: -80.2, latitude: 26.1 });
  assert.equal(isUsableBounds(point), false, 'a zero-width box selects nothing');
});

test('the polygon is a closed ring in GeoJSON order — longitude first', () => {
  const ring = boundsToPolygon({ west: -80.3, south: 26.0, east: -80.2, north: 26.1 });
  assert.deepEqual(ring, [[-80.3, 26.0], [-80.2, 26.0], [-80.2, 26.1], [-80.3, 26.1], [-80.3, 26.0]]);
  assert.deepEqual(ring[0], ring[ring.length - 1], 'the ring closes');
  assert.ok(ring.every(([lon, lat]) => lon < -79 && lat > 25), 'longitude leads, latitude follows');
  assert.deepEqual(boundsCenter({ west: -80.3, south: 26.0, east: -80.2, north: 26.1 }),
    { longitude: -80.25, latitude: 26.05 });
});

test('a point is in the box when it is, edges included', () => {
  assert.equal(pointInBounds(-80.252, 26.099, CORRIDOR_BOX), true);
  assert.equal(pointInBounds(-80.300, 26.099, CORRIDOR_BOX), false, 'west of it');
  assert.equal(pointInBounds(-80.252, 26.200, CORRIDOR_BOX), false, 'north of it');
  assert.equal(pointInBounds(CORRIDOR_BOX.west, CORRIDOR_BOX.south, CORRIDOR_BOX), true, 'a corner is inside');
  assert.equal(pointInBounds(null, 26.099, CORRIDOR_BOX), false);
});

test('a line crossing the box is found even when both its ends are outside — the case a distance test misses', () => {
  const box = { west: -1, south: -1, east: 1, north: 1 };
  assert.equal(segmentIntersectsBounds([-5, 0], [5, 0], box), true, 'straight through');
  assert.equal(segmentIntersectsBounds([-5, -5], [5, 5], box), true, 'diagonally through');
  assert.equal(segmentIntersectsBounds([-5, 3], [5, 3], box), false, 'passing above');
  assert.equal(segmentIntersectsBounds([0, 0], [0.5, 0.5], box), true, 'wholly inside');
  assert.equal(segmentIntersectsBounds([2, 2], [3, 3], box), false, 'wholly outside');
  // Parallel to an edge and running along it.
  assert.equal(segmentIntersectsBounds([-5, 1], [5, 1], box), true, 'along the north edge');
});

test('a LineString is in the box if any part of it is', () => {
  const box = { west: -1, south: -1, east: 1, north: 1 };
  assert.equal(lineStringIntersectsBounds([[-5, 5], [5, 5], [5, -5]], box), false, 'around the outside');
  assert.equal(lineStringIntersectsBounds([[-5, 5], [0, 0], [5, 5]], box), true, 'one vertex inside');
  assert.equal(lineStringIntersectsBounds([[-5, 0], [5, 0]], box), true, 'no vertex inside, but it crosses');
  assert.equal(lineStringIntersectsBounds([], box), false);
});

test('a polygon is in the box by vertex, by edge, or by containing it entirely', () => {
  const box = { west: -1, south: -1, east: 1, north: 1 };
  assert.equal(polygonIntersectsBounds([[[0, 0], [5, 0], [5, 5], [0, 0]]], box), true, 'a vertex inside');
  assert.equal(polygonIntersectsBounds([[[-5, 0], [5, 0], [5, 5], [-5, 0]]], box), true, 'an edge crossing');
  assert.equal(polygonIntersectsBounds([[[-9, -9], [9, -9], [9, 9], [-9, 9], [-9, -9]]], box), true,
    'the box is wholly inside the polygon and touches no edge');
  assert.equal(polygonIntersectsBounds([[[5, 5], [6, 5], [6, 6], [5, 5]]], box), false, 'well clear of it');
});

test('every GeoJSON shape the corridor data uses is dispatched, and an unknown one is not assumed in', () => {
  const box = { west: -1, south: -1, east: 1, north: 1 };
  assert.equal(geometryIntersectsBounds({ type: 'Point', coordinates: [0, 0] }, box), true);
  assert.equal(geometryIntersectsBounds({ type: 'MultiPoint', coordinates: [[9, 9], [0, 0]] }, box), true);
  assert.equal(geometryIntersectsBounds({ type: 'LineString', coordinates: [[-5, 0], [5, 0]] }, box), true);
  assert.equal(geometryIntersectsBounds({ type: 'MultiLineString', coordinates: [[[9, 9], [8, 8]], [[-5, 0], [5, 0]]] }, box), true);
  assert.equal(geometryIntersectsBounds({ type: 'Polygon', coordinates: [[[0, 0], [5, 0], [5, 5], [0, 0]]] }, box), true);
  assert.equal(geometryIntersectsBounds({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [0, 0] }] }, box), true);
  assert.equal(geometryIntersectsBounds({ type: 'Circle', coordinates: [0, 0] }, box), false, 'an unknown shape is not in');
  assert.equal(geometryIntersectsBounds(null, box), false);
});

test('a box over the corridor finds real FDOT segments in both directions', () => {
  const hits = segments.features.filter(feature => geometryIntersectsBounds(feature.geometry, CORRIDOR_BOX));
  assert.ok(hits.length >= 2, `expected both carriageways, got ${hits.length}`);
  const directions = new Set(hits.map(feature => feature.properties.direction));
  assert.deepEqual([...directions].sort(), ['EB', 'WB'], 'a box across the corridor spans both');
  // The express geometry runs between them here, so the same box must find it too.
  assert.equal(express.features.some(feature => geometryIntersectsBounds(feature.geometry, CORRIDOR_BOX)), true);
});

test('a box away from the corridor finds no segment at all, rather than the nearest one', () => {
  const offCorridor = { west: -80.30, south: 26.30, east: -80.28, north: 26.32 };
  assert.equal(segments.features.some(feature => geometryIntersectsBounds(feature.geometry, offCorridor)), false);
  assert.equal(express.features.some(feature => geometryIntersectsBounds(feature.geometry, offCorridor)), false);
});

test('a long box down the corridor spans more than one section', () => {
  const long = { west: -80.33, south: 26.08, east: -80.24, north: 26.13 };
  const hits = segments.features.filter(feature => geometryIntersectsBounds(feature.geometry, long));
  const eastbound = hits.filter(feature => feature.properties.direction === 'EB');
  assert.ok(eastbound.length >= 2, `a box this long crosses several EB sections, got ${eastbound.length}`);
});

test('the reported size is metres, and only ever used for the summary', () => {
  const size = boundsSizeMetres({ west: -80.25, south: 26.10, east: -80.24, north: 26.11 });
  assert.ok(size.heightM > 1100 && size.heightM < 1120, `${size.heightM} m tall`);
  assert.ok(size.widthM > 950 && size.widthM < 1010, `${size.widthM} m wide at 26°N`);
  assert.equal(boundsSizeMetres({ west: 1, south: 1, east: 1, north: 1 }), null);
});
