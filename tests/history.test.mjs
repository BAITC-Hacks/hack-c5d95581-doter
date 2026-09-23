import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createHistory } from '../lib/history.mjs';

const session = { id: 'session-a', provider: 'openai', model: 'gpt-realtime-2.1' };
const turn = { sessionId: session.id, turnId: 'turn-a', transcript: 'Где офис?', reply: 'В Алматы.',
  trace: { scenarios: [{ scenario_id: 'SC01' }], actions: [{ name: 'find_office', mode: 'read', result: { city: 'Алматы' } }] },
  state: { active_scenario: 'SC01' }, latency: { routing_ms: 42 } };

async function memory(t) {
  const history = createHistory({ env: {} });
  t.after(() => history.close());
  await history.ready;
  assert.deepEqual(history.status, { backend: 'memory', persistent: false, ready: true, available: true, error: null });
  return history;
}

test('memory audit stores transcript, reply, actions, state and latency without audio or shared references', async t => {
  const history = await memory(t);
  await history.startSession(session);
  const input = structuredClone({ ...turn, rawAudio: 'do-not-store' });
  await history.saveTurn(input);
  input.trace.actions[0].result.city = 'mutated';
  const result = await history.getSession(session.id);
  assert.equal(result.turnCount, 1);
  assert.deepEqual(result.turns[0].actions, turn.trace.actions);
  assert.deepEqual(result.turns[0].state, turn.state);
  assert.deepEqual(result.turns[0].latency, turn.latency);
  assert.equal(result.turns[0].transcript, turn.transcript);
  assert.equal(result.turns[0].reply, turn.reply);
  assert.equal(JSON.stringify(result).includes('do-not-store'), false);
  result.turns[0].trace.actions.length = 0;
  assert.equal((await history.getSession(session.id)).turns[0].actions.length, 1);
  await history.endSession(session.id);
  const ended = await history.getSession(session.id);
  assert.ok(ended.endedAt);
  await history.endSession(session.id);
  const again = await history.startSession({ ...session, model: 'must-not-rewrite' });
  assert.equal(again.endedAt, ended.endedAt);
  assert.equal(again.startedAt, ended.startedAt);
  assert.equal(again.model, session.model);
});

test('upsert keeps one turn and later metrics do not erase the audit payload', async t => {
  const history = await memory(t);
  await history.startSession(session);
  const first = await history.saveTurn(turn);
  await history.saveTurn({ ...turn, turnId: 'turn-b', transcript: 'Спасибо' });
  await history.saveTurn({ sessionId: session.id, turnId: turn.turnId, latency: { routing_ms: 42, total_ms: 120 } });
  const result = await history.getSession(session.id);
  assert.equal(result.turnCount, 2);
  assert.deepEqual(result.turns.map(x => x.turnId), ['turn-a', 'turn-b']);
  assert.equal(result.turns[0].createdAt, first.createdAt);
  assert.equal(result.turns[0].transcript, turn.transcript);
  assert.deepEqual(result.turns[0].actions, turn.trace.actions);
  assert.equal(result.turns[0].latency.total_ms, 120);
});

test('session and turn reads are bounded and report truncated results', async t => {
  const history = await memory(t);
  for (let i = 0; i < 101; i++) await history.startSession({ ...session, id: `s-${i}` });
  assert.equal((await history.listSessions({ limit: 100000 })).length, 100);
  assert.equal((await history.listSessions({ limit: 3 })).length, 3);
  assert.equal((await history.listSessions())[0].id, 's-100');
  for (let i = 0; i < 501; i++) await history.saveTurn({ sessionId: 's-100', turnId: String(i) });
  const bounded = await history.getSession('s-100', { limit: 100000 });
  assert.equal(bounded.turns.length, 500);
  assert.equal(bounded.turnCount, 501);
  assert.equal(bounded.turnsTruncated, true);
  assert.equal(await history.getSession('missing'), null);
});

test('invalid records reject; closed memory store cannot be reused', async t => {
  const history = await memory(t);
  await assert.rejects(history.startSession({ ...session, id: '' }), /id/);
  await assert.rejects(history.saveTurn(turn), /does not exist/);
  await history.startSession(session);
  await assert.rejects(history.saveTurn({ ...turn, transcript: 'x'.repeat(65537) }), /transcript/);
  await assert.rejects(history.saveTurn({ ...turn, state: [] }), /state/);
  await history.close();
  await history.close();
  assert.equal(history.status.ready, false);
  await assert.rejects(history.listSessions(), /closed/);
});

class FakePool extends EventEmitter {
  constructor(handler) { super(); this.handler = handler; this.calls = []; this.ended = false; }
  async query(sql, values) { this.calls.push({ sql, values }); return this.handler(sql, values); }
  async end() { this.ended = true; }
}

test('PostgreSQL failures stay explicit, contain no connection secret and never fall back to memory', async () => {
  const pool = new FakePool(() => { throw new Error('postgresql://user:private-password@database/voice'); });
  const history = createHistory({ env: { DATABASE_URL: 'postgresql://placeholder' }, poolFactory: () => pool });
  await assert.rejects(history.ready, error => error.message === 'History database is unavailable');
  assert.equal(history.status.backend, 'postgres');
  assert.equal(history.status.persistent, true);
  assert.equal(history.status.available, false);
  assert.equal(JSON.stringify(history.status).includes('private-password'), false);
  await assert.rejects(history.startSession(session), /unavailable/);
  await history.close();
  assert.equal(pool.ended, true);
});

test('PostgreSQL uses parameter binding for untrusted transcript and identifiers', async () => {
  const malicious = "x'); DROP TABLE voice_sessions; --";
  const pool = new FakePool((sql, values) => {
    if (!values) return { rows: [] };
    if (sql.includes('INSERT INTO voice_sessions')) return { rows: [{ id: values[0], provider: values[1], model: values[2], started_at: new Date(), ended_at: null }] };
    if (sql.includes('INSERT INTO voice_turns')) {
      const p = JSON.parse(values[2]);
      return { rows: [{ session_id: values[0], turn_id: values[1], transcript: p.transcript, reply: p.reply, trace: p.trace, state: p.state, latency: p.latency, created_at: new Date(), updated_at: new Date() }] };
    }
    return { rows: [] };
  });
  const history = createHistory({ env: { DATABASE_URL: 'postgresql://placeholder' }, poolFactory: () => pool });
  await history.ready;
  await history.startSession({ ...session, id: malicious });
  await history.saveTurn({ ...turn, sessionId: malicious, transcript: malicious });
  for (const call of pool.calls) assert.equal(call.sql.includes(malicious), false);
  assert.equal(pool.calls[1].values[0], malicious);
  assert.equal(JSON.parse(pool.calls[2].values[2]).transcript, malicious);
  pool.emit('error', new Error('connection lost with private data'));
  assert.equal(history.status.available, false);
  await history.listSessions();
  assert.equal(history.status.available, true);
  await history.close();
});

test('PostgreSQL audit survives a new application instance', { skip: !process.env.HISTORY_TEST_DATABASE_URL }, async () => {
  const env = { DATABASE_URL: process.env.HISTORY_TEST_DATABASE_URL };
  const sessionId = `audit-test-${randomUUID()}`;
  const ownerHash = 'c'.repeat(64);
  const first = createHistory({ env });
  try {
    await first.ready;
    await first.startSession({ ...session, id: sessionId, ownerHash });
    await first.saveTurn({ ...turn, sessionId });
    await first.saveTurn({ sessionId, turnId: turn.turnId, latency: { total_ms: 90 } });
    await first.endSession(sessionId);
  } finally { await first.close(); }
  const second = createHistory({ env });
  try {
    await second.ready;
    const stored = await second.getSession(sessionId, { ownerHash });
    assert.equal(await second.getSession(sessionId, { ownerHash: 'd'.repeat(64) }), null);
    assert.equal(stored.ownerHash, ownerHash);
    assert.equal(stored.turnCount, 1);
    assert.ok(stored.endedAt);
    assert.equal(stored.turns[0].transcript, turn.transcript);
    assert.deepEqual(stored.turns[0].actions, turn.trace.actions);
    assert.equal(stored.turns[0].latency.total_ms, 90);
    assert.equal((await second.listSessions()).some(x => x.id === sessionId), true);
  } finally { await second.close(); }
});

test('browser owner hashes isolate history and cannot take over an existing session', async t => {
  const history = await memory(t);
  const ownerHash = 'a'.repeat(64), otherHash = 'b'.repeat(64);
  await history.startSession({ ...session, ownerHash });
  await history.saveTurn(turn);
  assert.equal((await history.getSession(session.id, { ownerHash })).ownerHash, ownerHash);
  assert.equal(await history.getSession(session.id, { ownerHash: otherHash }), null);
  await assert.rejects(history.startSession({ ...session, ownerHash: otherHash }), /owner mismatch/);
  await assert.rejects(history.startSession({ ...session, id: 'bad-hash', ownerHash: 'plaintext-token' }), /SHA-256/);
  await assert.rejects(history.getSession(session.id, { ownerHash: '' }), /SHA-256/);
  assert.equal((await history.getSession(session.id)).turnCount, 1);
});
