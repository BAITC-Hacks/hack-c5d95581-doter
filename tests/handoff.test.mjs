import test from 'node:test';
import assert from 'node:assert/strict';
import { loadData } from '../lib/catalog.mjs';
import { createSession, processTurn } from '../lib/engine.mjs';

test('confirmed claim remains executed in the subsequent operator handoff', () => {
  const data = loadData();
  for (const [scenario, product, description] of [['SC13', 'casco', 'Угон автомобиля'], ['SC14', 'property', 'Пожар, есть пострадавшие']]) {
    const session = createSession(data);
    const policy = session.backend.policies.find(p => p.product === product && p.start_date <= '2026-10-01' && p.end_date >= '2026-10-01' && p.status !== 'cancelled');
    assert.ok(policy);
    const route = (slots, confirmation = 'none') => ({ scenarios: [{ scenario_id: scenario, confidence: 0.99, reason: 'Synthetic claim test' }], alternatives: [], slots, language: 'ru', is_continuation: confirmation === 'confirm', confirmation });
    const preview = processTurn(session, route({ policy_number: policy.policy_number, incident_date: '2026-10-01', incident_description: description }), { transcript: description });
    assert.equal(preview.trace.status, 'awaiting_confirmation');
    const confirmed = processTurn(session, route({}, 'confirm'), { transcript: 'Да, подтверждаю' });
    const claim = confirmed.trace.actions.find(a => a.name === 'create_claim' && a.mode === 'execute');
    assert.ok(claim && !claim.result.error);
    const handoff = confirmed.trace.actions.find(a => a.name === 'transfer_to_operator');
    assert.ok(handoff);
    assert.equal(handoff.result.context.confirmation_status, 'executed');
    assert.equal(handoff.result.context.pending_confirmation, null);
  }
});
