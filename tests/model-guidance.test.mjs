import test from 'node:test';
import assert from 'node:assert/strict';
import { modelGuidance, withModelGuidance } from '../lib/model-guidance.mjs';

test('pricing is exact-ID scoped and never inferred from mini in a name', () => {
  assert.equal(modelGuidance('gpt-realtime-2.1-mini').audioPrice.input, 10);
  assert.equal(modelGuidance('gemini-3.8-live').audioPrice.output, 12);
  assert.equal(modelGuidance('gpt-realtime-mini').audioPrice, undefined);
  assert.equal(modelGuidance('future-realtime-mini').audioPrice, undefined);
  assert.equal(modelGuidance('future-realtime-mini').tag, 'Без оценки');
});
test('guidance preserves every discovered model and returns independent metadata', () => {
  const models = [{ id: 'gpt-realtime-2.1', label: 'chosen' }, { id: 'unknown', label: 'unknown' }];
  const result = withModelGuidance(models);
  assert.deepEqual(result.map(m => m.id), models.map(m => m.id));
  result[0].guidance.audioPrice.input = 0;
  assert.equal(modelGuidance('gpt-realtime-2.1').audioPrice.input, 32);
});
