/**
 * Grading for the verified-question evals (config/askTwin/evals.json, npm run ask:eval). Pure: one
 * run's events and answer in, a list of failed expectations out, so the same checks run against the
 * real model on a laptop and against recordings in node:test.
 */
const LEVELS = { low: 0, medium: 1, high: 2 };

/**
 * @param {{events: object[], answer: object|null}} run
 * @param {object} expect  see config/askTwin/evals.json
 * @returns {{passed: boolean, failures: string[], summary: object}}
 */
export function gradeRun({ events, answer }, expect = {}) {
  const failures = [];
  const calls = events.filter(e => e.type === 'ToolCallStart');
  const used = calls.map(e => e.name);
  const rounds = events.filter(e => e.type === 'ModelRound').reduce((max, e) => Math.max(max, e.round ?? 0), 0);
  const error = events.find(e => e.type === 'RunError');
  if (error || !answer) {
    failures.push(`no answer${error ? `: ${error.message}` : ''}`);
    return { passed: false, failures, summary: { used, rounds } };
  }
  if (expect.tools?.length && !used.some(name => expect.tools.includes(name))) failures.push(`expected one of [${expect.tools.join(', ')}], used [${used.join(', ') || 'none'}]`);
  if (expect.classIncludes && !calls.some(e => String(e.input?.class_name ?? '').includes(expect.classIncludes))) failures.push(`no lookup on a class containing "${expect.classIncludes}"`);
  for (const name of expect.mustNotUse ?? []) if (used.includes(name)) failures.push(`must not use ${name}`);
  const level = LEVELS[answer.confidence] ?? -1;
  const gapped = answer.gaps?.length > 0 || calls.length > 0 && events.some(e => e.type === 'ToolCallEnd' && e.status === 'gap');
  if (expect.minConfidence && level < LEVELS[expect.minConfidence] && !(expect.allowGap && gapped)) failures.push(`confidence ${answer.confidence}, expected at least ${expect.minConfidence}`);
  if (expect.maxConfidence && level > LEVELS[expect.maxConfidence]) failures.push(`confidence ${answer.confidence}, expected at most ${expect.maxConfidence}`);
  if (expect.gaps && !answer.gaps?.length) failures.push('expected the answer to state a data gap');
  if (expect.answerMatches && !new RegExp(expect.answerMatches, 'i').test(answer.answer ?? '')) failures.push(`answer does not match /${expect.answerMatches}/`);
  if (expect.blocks && !answer.blocks?.length) failures.push('expected answer blocks');
  if (expect.maxRounds && rounds > expect.maxRounds) failures.push(`${rounds} model rounds, budget ${expect.maxRounds}`);
  if (!String(answer.answer ?? '').trim()) failures.push('empty answer');
  return { passed: failures.length === 0, failures, summary: { used, rounds, confidence: answer.confidence, gaps: answer.gaps?.length ?? 0 } };
}
