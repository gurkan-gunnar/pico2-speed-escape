import assert from 'node:assert/strict';
import { parseEquation, parseProgress, QuizGuard } from '../docs/recognition.js';

assert.equal(parseProgress('Question 1 / 5'), 1);
assert.equal(parseProgress('Question 5/5'), 5);
assert.equal(parseProgress('Level 1'), null);
assert.deepEqual(parseEquation('2 x 3 = ?'), { a: 2, b: 3 });
assert.deepEqual(parseEquation('12×12=?'), { a: 12, b: 12 });
assert.equal(parseEquation('14 x 3 = ?'), null);

const guard = new QuizGuard();
const q1 = { question: 1, a: 2, b: 3 };
assert.equal(guard.observe(q1, 1000), null);
const candidate = guard.observe(q1, 2000);
assert.deepEqual(candidate, { key: '1:2x3', ...q1 });
guard.markSent(candidate);
assert.equal(guard.observe(q1, 3000), null);
assert.equal(guard.observe({ question: 3, a: 4, b: 5 }, 4000), null);
for (let q = 2; q <= 5; q++) {
  const result = { question: q, a: 2, b: 3 };
  guard.observe(result, 5000 + q * 1000);
  const next = guard.observe(result, 5100 + q * 1000);
  assert.equal(next.question, q);
  guard.markSent(next);
}
guard.observe(null, 12000);
guard.observe(null, 16001);
assert.equal(guard.observe(q1, 17000), null);
assert.equal(guard.observe(q1, 18000)?.question, 1);
console.log('Recognition and quiz guard checks passed.');
