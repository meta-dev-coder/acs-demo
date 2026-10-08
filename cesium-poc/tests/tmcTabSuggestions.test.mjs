/**
 * The chat follows the tab the operator is reading.
 *
 * Each suggestion has to be answerable from the deterministic services — a suggested question the
 * application cannot answer is worse than no suggestion, because the operator has to discover the
 * gap by asking.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTmcQuestion, TMC_HISTORICAL_INCIDENT_SUGGESTIONS, TMC_TAB_SUGGESTIONS, tmcSuggestionsForTab,
} from '../src/tmc/tmcAnswers.js';

test('every suggested question parses to an intent the services can answer', () => {
  for (const [tab, questions] of Object.entries(TMC_TAB_SUGGESTIONS)) {
    for (const question of questions) {
      assert.ok(parseTmcQuestion(question), `${tab}: "${question}" has no intent`);
    }
  }
});

test('each tab asks about what is on that tab', () => {
  const intents = tab => TMC_TAB_SUGGESTIONS[tab].map(parseTmcQuestion);
  assert.ok(intents('overview').includes('WHY_RISK'));
  assert.ok(intents('overview').includes('INCIDENT_WEATHER'));
  assert.ok(intents('overview').includes('DATA_GAPS'));
  // History asks about the location, never about the incident's own response.
  assert.ok(intents('history').includes('LOCATION_HISTORY'));
  assert.ok(intents('history').includes('LOCATION_CRASH_TYPES'));
  assert.ok(intents('history').includes('LOCATION_TIME'));
  assert.ok(!intents('history').includes('MITIGATION'));
  // Response asks what to do and what with.
  assert.ok(intents('response').includes('MITIGATION'));
  assert.ok(intents('response').includes('UPSTREAM_CAMERAS'));
  // "Which DMS are upstream?" now resolves to UPSTREAM_DMS, which answers the same question but
  // separates where the sign IS from whether it warned — the feed publishes no activation record,
  // and the older intent could not say so as plainly.
  assert.ok(intents('response').includes('UPSTREAM_DMS'));
  assert.ok(!intents('response').includes('LOCATION_CRASH_TYPES'));
});

test('an unknown or absent tab falls back rather than offering nothing', () => {
  assert.equal(tmcSuggestionsForTab('history'), TMC_TAB_SUGGESTIONS.history);
  assert.equal(tmcSuggestionsForTab(null, TMC_HISTORICAL_INCIDENT_SUGGESTIONS), TMC_HISTORICAL_INCIDENT_SUGGESTIONS);
  assert.equal(tmcSuggestionsForTab('nonsense', TMC_HISTORICAL_INCIDENT_SUGGESTIONS), TMC_HISTORICAL_INCIDENT_SUGGESTIONS);
});

test('the root-cause protection is not reachable from a suggestion by accident', () => {
  // "What caused this accident?" stays a question the operator types. Every suggested question
  // that mentions cause must route to the contributing-circumstances answer, never invent one.
  for (const questions of Object.values(TMC_TAB_SUGGESTIONS)) {
    for (const question of questions) {
      if (/cause/i.test(question)) {
        assert.equal(parseTmcQuestion(question), 'LOCATION_FACTORS', `"${question}" must not be a root-cause claim`);
      }
    }
  }
});
