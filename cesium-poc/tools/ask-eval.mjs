/**
 * Runs the verified questions (config/askTwin/evals.json) through the same Ask the Twin service as
 * `npm run ask:serve`, in-process, and grades each run's events (server/ask/evalGrade.mjs).
 *
 *   npm run ask:eval                          # real model, settings from .env.local; costs a few cents
 *   npm run ask:eval -- --only rain-count,turnpike-history
 *   npm run ask:eval -- --record .twin-store/eval-rec.json   # save the model's responses
 *   npm run ask:eval -- --replay .twin-store/eval-rec.json   # re-grade offline, free, deterministic
 *
 * Uses the store at ASK_TWIN_STORE (default .twin-store/twin.sqlite) as it is: no DataConnect refresh
 * during an eval, so two runs see the same data. Writes .twin-store/eval-report.json. Exit code 1 when
 * any question fails.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const EVALS_PATH = join(ROOT, 'config', 'askTwin', 'evals.json');

export function parseArgs(argv) {
  const args = { only: null, record: null, replay: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only' && argv[i + 1]) args.only = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (argv[i] === '--record' && argv[i + 1]) args.record = resolve(argv[++i]);
    else if (argv[i] === '--replay' && argv[i + 1]) args.replay = resolve(argv[++i]);
    else throw new Error(`unknown argument '${argv[i]}'`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { loadServerEnv } = await import('../server/loadEnv.mjs');
  loadServerEnv();
  const env = { ...process.env, ASK_TWIN_REFRESH: 'off', ...(args.record ? { ASK_TWIN_RECORD: args.record } : {}), ...(args.replay ? { ASK_TWIN_REPLAY: args.replay } : {}) };
  const { createLiveDcReadApi } = await import('../server/liveDc/liveReadApi.mjs');
  const { createLiveEventsApi } = await import('../server/api.mjs');
  const { createLocalAsk } = await import('../server/ask/localAsk.mjs');
  const { sanitizeEnvelope } = await import('../server/ask/envelope.mjs');
  const { gradeRun } = await import('../server/ask/evalGrade.mjs');

  const liveEvents = createLiveEventsApi({ liveDc: createLiveDcReadApi() });
  const ask = createLocalAsk({ env, logger: { log() {}, warn: console.warn, error: console.error },
    getLiveEvents: async () => (await liveEvents.dataConnectEvents().catch(() => null)) ?? liveEvents.fl511Events().catch(() => null) });
  if (!ask.orchestrator) throw new Error(ask.label);
  console.log(`ask-eval: ${ask.label}`);

  const { questions } = JSON.parse(readFileSync(EVALS_PATH, 'utf8'));
  const chosen = args.only ? questions.filter(q => args.only.includes(q.id)) : questions;
  const results = [];
  for (const q of chosen) {
    const events = [];
    const t0 = Date.now();
    const answer = await ask.orchestrator.run(sanitizeEnvelope({ question: q.question, ...(q.screen ? { screen: q.screen } : {}) }), e => events.push(e));
    const graded = gradeRun({ events, answer }, q.expect);
    const ms = Date.now() - t0;
    results.push({ id: q.id, question: q.question, ms, ...graded, answer: answer?.answer ?? null, confidence: answer?.confidence ?? null });
    console.log(`${graded.passed ? 'PASS' : 'FAIL'}  ${q.id.padEnd(20)} ${String(ms).padStart(6)} ms  ${graded.summary.rounds} rounds  [${graded.summary.used.join(', ')}]${graded.passed ? '' : `\n      ${graded.failures.join('\n      ')}`}`);
  }
  const passed = results.filter(r => r.passed).length;
  const report = join(ROOT, '.twin-store', 'eval-report.json');
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, `${JSON.stringify({ at: new Date().toISOString(), model: ask.label, passed, total: results.length, results }, null, 2)}\n`);
  console.log(`\n${passed}/${results.length} passed · median ${median(results.map(r => r.ms))} ms · report ${report}`);
  ask.refresher?.stop();
  await liveEvents.stop?.();
  process.exitCode = passed === results.length ? 0 : 1;
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`ask-eval: ${error.message}`); process.exitCode = 1; });
}
