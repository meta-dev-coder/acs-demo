import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpendGuard, weightedTokens } from '../server/ask/spendGuard.mjs';
import { createFallbackProvider, ProviderError } from '../server/ask/modelProvider.mjs';
import { createOrchestrator } from '../server/ask/orchestrator.mjs';
import { sanitizeEnvelope } from '../server/ask/envelope.mjs';

const quiet = { log() {}, warn() {}, error() {} };

test('spend guard: weighted daily tokens, persisted, reset at UTC midnight', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spend-'));
  try {
    let t = Date.parse('2026-10-11T10:00:00Z');
    const path = join(dir, 'ask-spend.json');
    assert.equal(weightedTokens({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 }), 250);
    const guard = createSpendGuard({ dailyTokens: 300, statePath: path, now: () => t, logger: quiet });
    assert.equal(guard.blocked(), null);
    guard.record({ input_tokens: 200, output_tokens: 100 });
    assert.match(guard.blocked(), /today's usage limit/);
    assert.equal(createSpendGuard({ dailyTokens: 300, statePath: path, now: () => t }).status().tokens, 300, 'a restart keeps the count');
    t = Date.parse('2026-10-12T00:00:01Z');
    assert.equal(guard.blocked(), null);
    assert.equal(createSpendGuard({ dailyTokens: 0 }).blocked(), null, 'no limit set');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('over the daily limit, a question ends before any model call', async () => {
  let called = 0;
  const provider = { name: 'p', complete: async () => { called++; return { content: [], stop_reason: 'end_turn' }; } };
  const tools = { definitions: [], run: async () => ({}) };
  const spend = { blocked: () => 'limit reached', record() { throw new Error('nothing to record'); } };
  const events = [];
  const answer = await createOrchestrator({ provider, tools, logger: quiet, system: 's', spend }).run(sanitizeEnvelope({ question: 'q' }), e => events.push(e));
  assert.equal(answer, null);
  assert.equal(called, 0);
  assert.equal(events.find(e => e.type === 'RunError').message, 'limit reached');
});

test('fallback model: used for overload or 5xx, never for a bad request or a rate limit', async () => {
  const fail = error => ({ name: 'a', model: 'primary', complete: async () => { throw error; } });
  const fallback = { name: 'b', model: 'second', complete: async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }) };
  const over = await createFallbackProvider(fail(new ProviderError('overloaded', { retryable: true, status: 529 })), fallback, { logger: quiet }).complete({});
  assert.equal(over.served_by, 'second');
  assert.equal((await createFallbackProvider(fail(new ProviderError('down', { retryable: true })), fallback, { logger: quiet }).complete({})).served_by, 'second');
  await assert.rejects(createFallbackProvider(fail(new ProviderError('bad', { status: 400 })), fallback, { logger: quiet }).complete({}), /bad/);
  await assert.rejects(createFallbackProvider(fail(new ProviderError('rate', { retryable: true, status: 429 })), fallback, { logger: quiet }).complete({}), /rate/);
});
