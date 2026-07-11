import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const segmentsPath = path.join(__dirname, "..", "config", "segments.json");

function loadSegments() {
  const raw = readFileSync(segmentsPath, "utf-8");
  return JSON.parse(raw);
}

test("segments.json is a non-empty array", () => {
  const segments = loadSegments();
  assert.ok(Array.isArray(segments), "segments.json must be an array");
  assert.ok(segments.length > 0, "segments.json must not be empty");
});

test("every segment has required fields with valid shapes", () => {
  const segments = loadSegments();
  for (const seg of segments) {
    assert.equal(typeof seg.id, "string", `id must be a string (${JSON.stringify(seg)})`);
    assert.ok(seg.id.length > 0, "id must not be empty");
    assert.equal(typeof seg.name, "string", `name must be a string (${seg.id})`);
    assert.ok(seg.name.length > 0, "name must not be empty");
    assert.ok(Array.isArray(seg.lonBand), `lonBand must be an array (${seg.id})`);
    assert.equal(seg.lonBand.length, 2, `lonBand must have exactly 2 entries (${seg.id})`);
    assert.equal(typeof seg.laneCount, "number", `laneCount must be a number (${seg.id})`);
    assert.equal(typeof seg.demandScale, "number", `demandScale must be a number (${seg.id})`);
  }
});

test("lonBand entries are ascending [minLon, maxLon]", () => {
  const segments = loadSegments();
  for (const seg of segments) {
    const [minLon, maxLon] = seg.lonBand;
    assert.ok(typeof minLon === "number" && Number.isFinite(minLon), `lonBand[0] finite (${seg.id})`);
    assert.ok(typeof maxLon === "number" && Number.isFinite(maxLon), `lonBand[1] finite (${seg.id})`);
    assert.ok(minLon < maxLon, `lonBand must be ascending [min, max] (${seg.id}: ${minLon}, ${maxLon})`);
  }
});

test("laneCount is a positive integer for every segment", () => {
  const segments = loadSegments();
  for (const seg of segments) {
    assert.ok(seg.laneCount > 0, `laneCount must be > 0 (${seg.id})`);
    assert.ok(Number.isInteger(seg.laneCount), `laneCount must be an integer (${seg.id})`);
  }
});

test("demandScale is positive for every segment", () => {
  const segments = loadSegments();
  for (const seg of segments) {
    assert.ok(seg.demandScale > 0, `demandScale must be > 0 (${seg.id})`);
  }
});

test("segment ids are unique", () => {
  const segments = loadSegments();
  const ids = segments.map((s) => s.id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, "segment ids must be unique");
});

test("segment names are unique", () => {
  const segments = loadSegments();
  const names = segments.map((s) => s.name);
  const unique = new Set(names);
  assert.equal(unique.size, names.length, "segment names must be unique");
});

test("lonBands do not overlap across segments", () => {
  const segments = loadSegments();
  const sorted = [...segments].sort((a, b) => a.lonBand[0] - b.lonBand[0]);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    assert.ok(
      prev.lonBand[1] <= cur.lonBand[0],
      `lonBand overlap between ${prev.id} (${prev.lonBand}) and ${cur.id} (${cur.lonBand})`
    );
  }
});
