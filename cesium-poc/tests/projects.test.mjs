/**
 * The project registry.
 *
 * Two things are held here. The first is that `?demo=i595` keeps opening I-595 — that address is
 * in bookmarks, in the deploy README and in every e2e script in this repository, and the registry
 * replaced the `if` that used to serve it. The second is that a project carries everything the
 * shell needs to open it, so adding a third is one entry rather than an edit to the dispatcher.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { LEGACY_PAGE, PROJECTS, PROJECT_PARAM, projectFor, urlForProject } from '../src/projects.js';

test('both projects are registered, with the ids the brief names', () => {
  assert.deepEqual(PROJECTS.map(project => project.id), ['i595', 'construction-integration']);
  assert.equal(PROJECTS[1].label, 'Construction Integration Demo');
  assert.equal(PROJECTS[1].description,
    'SYNCHRO 4D integration with Primavera P6, ACC/Revit, and SAP.');
});

test('?demo=i595 still opens I-595', () => {
  assert.equal(projectFor('?demo=i595').id, 'i595');
  assert.equal(projectFor('?demo=i595&intro=off&data=mock').id, 'i595');
});

test('?demo=construction-integration opens the new project', () => {
  assert.equal(projectFor('?demo=construction-integration').id, 'construction-integration');
});

test('an unknown or absent project falls through to the legacy page, as it always did', () => {
  assert.equal(projectFor(''), null);
  assert.equal(projectFor('?renderer=arcgis'), null);
  assert.equal(projectFor('?demo=nonesuch'), null);
  assert.equal(LEGACY_PAGE.id, null);
  assert.equal(typeof LEGACY_PAGE.load, 'function');
});

test('every project can be loaded and carries what the loader needs to say', () => {
  for (const project of PROJECTS) {
    assert.equal(typeof project.load, 'function', `${project.id} must be loadable`);
    for (const key of ['label', 'description', 'bootTitle', 'bootNote']) {
      assert.ok(project[key], `${project.id} is missing ${key}`);
    }
  }
});

test('only the construction project is marked synthetic', () => {
  assert.equal(PROJECTS.find(p => p.id === 'i595').synthetic, undefined);
  assert.equal(PROJECTS.find(p => p.id === 'construction-integration').synthetic, true);
});

test('switching project keeps every other parameter the operator is carrying', () => {
  const url = urlForProject('construction-integration', '?demo=i595&intro=off&acsDemo=1');
  const params = new URLSearchParams(url.slice(1));
  assert.equal(params.get(PROJECT_PARAM), 'construction-integration');
  assert.equal(params.get('intro'), 'off');
  assert.equal(params.get('acsDemo'), '1');
  // And back again, losing nothing.
  assert.equal(new URLSearchParams(urlForProject('i595', url.slice(1))).get('demo'), 'i595');
});
