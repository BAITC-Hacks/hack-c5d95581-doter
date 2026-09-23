import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../server.mjs';
import { createHistory } from '../lib/history.mjs';

async function fixture(t, options = {}) {
  const app = createApp(options);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());
  return { app, base, socketURL: base.replace('http:', 'ws:') + '/ws' };
}
async function client(t, url, options = {}) {
  const ws = new WebSocket(url, { origin: url.replace('ws:', 'http:').replace('/ws', ''), ...options });
  const messages = [];
  const pending = new Set();
  ws.on('message', raw => {
    const event = JSON.parse(raw.toString()); messages.push(event);
    for (const waiter of pending) if (waiter.predicate(event)) { pending.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(event); }
  });
  await once(ws, 'open');
  t.after(() => ws.terminate());
  function wait(predicate) {
    const found = messages.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => { pending.delete(waiter); reject(new Error('Timed out waiting for server event')); }, 3000) }; pending.add(waiter);
    });
  }
  return { ws, messages, wait, send: value => ws.send(JSON.stringify(value)) };
}

test('public configuration exposes presence only; private files unavailable', async t => {
  const { base } = await fixture(t, { env: { OPENAI_API_KEY: 'test-secret-never-public' } });
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/app.js')).status, 200);
  const config = await (await fetch(base + '/api/config')).json();
  assert.equal(config.providers.openai.configured, true);
  assert.equal(config.catalog.length, 43);
  assert.equal(config.asOfDate, '2026-10-01');
  assert.ok(!JSON.stringify(config).includes('test-secret-never-public'));
  for (const file of ['/.env', '/package.json', '/lib/engine.mjs', '/data/mock_backend.json']) assert.equal((await fetch(base + file)).status, 404);
});

test('missing credentials produce actionable error without API call', async t => {
  let calls = 0;
  const { socketURL } = await fixture(t, { env: {}, connect: async () => { calls++; throw new Error('must not connect'); } });
  const c = await client(t, socketURL);
  c.send({ type: 'start', provider: 'openai' });
  assert.match((await c.wait(e => e.type === 'error')).message, /OPENAI_API_KEY/);
  assert.equal(calls, 0);
});

test('text route emits grounded trace and only then audio; stop closes provider', async t => {
  let closed = 0;
  const connect = async ({ onEvent, onRoute }) => {
    onEvent({ type: 'status', status: 'ready' });
    return {
      sendAudio() {}, speak() {}, close() { closed++; },
      sendText(text) {
        onEvent({ type: 'interrupt' });
        Promise.resolve().then(async () => {
          onEvent({ type: 'transcript', role: 'user', text, final: true });
          const result = await onRoute({ transcript: text, scenarios: [{ scenario_id: 'SYS_OUT_OF_SCOPE', confidence: 0.9, reason: 'Запрос не относится к страхованию' }], alternatives: [], slots: {}, language: 'ru', is_continuation: false, confirmation: 'none' });
          onEvent({ type: 'transcript', role: 'assistant', text: result.reply, final: true });
          onEvent({ type: 'audio', data: Buffer.alloc(960).toString('base64'), sampleRate: 24000 });
        });
      },
    };
  };
  const { socketURL } = await fixture(t, { env: { OPENAI_API_KEY: 'test-key' }, connect });
  const c = await client(t, socketURL);
  c.send({ type: 'start', provider: 'openai' });
  await c.wait(e => e.type === 'status' && e.status === 'ready');
  c.send({ type: 'text', text: 'Хочу заказать пиццу' });
  const trace = await c.wait(e => e.type === 'trace');
  const audio = await c.wait(e => e.type === 'audio');
  assert.equal(trace.trace.scenarios[0].scenario_id, 'SYS_OUT_OF_SCOPE');
  assert.equal(audio.turnId, trace.turnId);
  assert.ok(!c.messages.some(e => e.type === 'interrupt' && e.turnId === trace.turnId), 'new text turn must not cancel its own audio');
  assert.ok(c.messages.indexOf(trace) < c.messages.indexOf(audio));
  assert.equal(trace.latency_ms.stt, null);
  c.send({ type: 'playback_started', turnId: trace.turnId, at: Date.now() });
  const metrics = await c.wait(e => e.type === 'metrics' && e.latency_ms.end_to_first_audio !== null);
  assert.ok(metrics.latency_ms.end_to_first_audio >= 0);
  c.send({ type: 'stop' });
  await c.wait(e => e.type === 'status' && e.status === 'stopped');
  assert.equal(closed, 1);
});

test('cross-origin websocket is rejected', async t => {
  const { socketURL } = await fixture(t, { env: {} });
  const ws = new WebSocket(socketURL, { origin: 'https://unrelated.example' });
  const [error] = await once(ws, 'error');
  assert.match(error.message, /403/);
  ws.terminate();
});

test('Gemini audio turns preserve full tool transcript and keep independent routes', async t => {
  let callbacks;
  const connect = async options => {
    callbacks = options;
    options.onEvent({ type: 'status', status: 'ready' });
    return { close() {}, sendAudio() {}, sendText() {} };
  };
  const { socketURL } = await fixture(t, { env: { GEMINI_API_KEY: 'test-key' }, connect });
  const c = await client(t, socketURL);
  c.send({ type: 'start', provider: 'gemini' });
  await c.wait(e => e.type === 'status' && e.status === 'ready');
  for (let index = 1; index <= 2; index++) {
    const turnKey = `gemini-${index}`;
    const text = `Закажите пиццу номер ${index}`;
    callbacks.onEvent({ type: 'turn_started', source: 'audio', turnKey });
    callbacks.onEvent({ type: 'transcript', role: 'user', text: 'Закажите', final: false, turnKey });
    await callbacks.onRoute({ transcript: text, scenarios: [{ scenario_id: 'SYS_OUT_OF_SCOPE', confidence: 0.99, reason: 'Не страхование' }], alternatives: [], slots: {}, language: 'ru', is_continuation: false, confirmation: 'none' }, { turnKey });
    callbacks.onEvent({ type: 'audio', data: Buffer.alloc(960).toString('base64'), sampleRate: 24000, turnKey });
    const trace = await c.wait(e => e.type === 'trace' && e.turnId === `turn-${index}`);
    const audio = await c.wait(e => e.type === 'audio' && e.turnId === `turn-${index}`);
    assert.equal(trace.trace.transcript, text, 'partial ASR must not replace complete route-tool transcription');
    assert.equal(trace.trace.transcript_source, 'route_tool');
    assert.equal(trace.latency_ms.route, null, 'no input-end event means no invented latency');
    assert.equal(audio.turnId, trace.turnId);
  }
  const count = c.messages.filter(e => e.type === 'audio').length;
  callbacks.onEvent({ type: 'audio', data: Buffer.alloc(960).toString('base64'), sampleRate: 24000, turnKey: 'gemini-1' });
  c.send({ type: 'stop' });
  await c.wait(e => e.type === 'status' && e.status === 'stopped');
  assert.equal(c.messages.filter(e => e.type === 'audio').length, count, 'late audio from an old turn stays blocked');
});

test('discovered model selection is enforced and microphone end is forwarded', async t => {
  let chosen, audioEnds = 0, calls = 0;
  const connect = async options => {
    calls++; chosen = options.model;
    options.onEvent({ type: 'status', status: 'ready' });
    return { close() {}, sendAudio() {}, sendText() {}, endAudio() { audioEnds++; } };
  };
  const modelDiscovery = async () => ({ models: [{ id: 'gpt-realtime-test', label: 'Test voice' }], verified: true });
  const { app, socketURL } = await fixture(t, { env: { OPENAI_API_KEY: 'test-key' }, connect, modelDiscovery });
  await app.refreshModels();
  const c = await client(t, socketURL);
  c.send({ type: 'start', provider: 'openai', model: 'unlisted-model' });
  await c.wait(e => e.type === 'error');
  assert.equal(calls, 0);
  c.send({ type: 'start', provider: 'openai', model: 'gpt-realtime-test' });
  await c.wait(e => e.type === 'status' && e.status === 'ready');
  c.send({ type: 'audio_end' });
  c.send({ type: 'text', text: '' });
  await c.wait(e => e.type === 'error' && /8000/.test(e.message));
  assert.equal(chosen, 'gpt-realtime-test');
  assert.equal(audioEnds, 1);
});
test('terminal provider failure stops capture delivery and allows a fresh connection', async t => {
  const callbacks = [];
  let audioCalls = 0, closed = 0;
  const connect = async options => {
    callbacks.push(options);
    options.onEvent({ type: 'status', status: 'ready' });
    return { close() { closed++; }, sendAudio() { audioCalls++; }, sendText() {} };
  };
  const { socketURL } = await fixture(t, { env: { OPENAI_API_KEY: 'test-key' }, connect });
  const c = await client(t, socketURL);
  c.send({ type: 'start', provider: 'openai' });
  await c.wait(e => e.type === 'status' && e.status === 'ready');
  callbacks[0].onEvent({ type: 'error', message: 'Recoverable route error' });
  await c.wait(e => e.type === 'error' && e.message === 'Recoverable route error');
  c.send({ type: 'audio', data: 'AAA=' });
  c.send({ type: 'text', text: '' });
  await c.wait(e => e.type === 'error' && /8000/.test(e.message));
  assert.equal(audioCalls, 1, 'recoverable error must keep the session usable');
  callbacks[0].onEvent({ type: 'error', message: 'Upstream disconnected', fatal: true });
  await c.wait(e => e.type === 'status' && e.status === 'stopped');
  assert.equal(closed, 1);
  c.send({ type: 'audio', data: 'AAA=' });
  c.send({ type: 'start', provider: 'openai' });
  await c.wait(e => e.type === 'status' && e.status === 'ready' && c.messages.filter(x => x.type === 'status' && x.status === 'ready').length === 2);
  assert.equal(audioCalls, 1, 'no frame after a terminal failure reaches a dead connection');
  assert.equal(callbacks.length, 2, 'reconnection creates exactly one fresh provider');
  callbacks[0].onEvent({ type: 'error', message: 'Late old failure', fatal: true });
  c.send({ type: 'audio', data: 'AAA=' });
  c.send({ type: 'unknown-probe' });
  await c.wait(e => e.type === 'error' && /Неизвестная команда/.test(e.message));
  assert.equal(audioCalls, 2);
  assert.equal(c.messages.filter(e => e.type === 'status' && e.status === 'stopped').length, 1);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const noOpProvider = onEvent => {
  onEvent({ type: 'status', status: 'ready' });
  return { close() {}, sendAudio() {}, sendText() {} };
};
async function browserCookie(base) {
  const response = await fetch(base + '/api/config');
  const header = response.headers.get('set-cookie');
  assert.match(header, /^vr_owner=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000/);
  return header.split(';')[0];
}

test('history HTTP access requires the owning browser cookie and never exposes the owner hash', async t => {
  const { base, socketURL } = await fixture(t, { env: { OPENAI_API_KEY: 'offline-history-key' },
    connect: async ({ onEvent }) => noOpProvider(onEvent) });
  const cookie = await browserCookie(base);
  const c = await client(t, socketURL, { headers: { Cookie: cookie } });
  c.send({ type: 'start' });
  const saved = await c.wait(event => event.type === 'history');
  await c.wait(event => event.status === 'ready');
  const url = base + '/api/history/' + saved.sessionId;
  const mine = await fetch(url, { headers: { Cookie: cookie } });
  assert.equal(mine.status, 200);
  const record = await mine.json();
  assert.equal(record.id, saved.sessionId);
  assert.equal(Object.hasOwn(record, 'ownerHash'), false);
  assert.equal(JSON.stringify(record).includes(cookie.split('=')[1]), false);
  assert.equal(JSON.stringify(record).includes('offline-history-key'), false);
  assert.equal((await fetch(url)).status, 403);
  const otherCookie = await browserCookie(base);
  assert.notEqual(otherCookie, cookie);
  assert.equal((await fetch(url, { headers: { Cookie: otherCookie } })).status, 404);
  assert.equal((await fetch(base + '/api/history')).status, 404, 'no public session listing');
  c.send({ type: 'stop' });
  await c.wait(event => event.status === 'stopped');
  const ended = await (await fetch(url, { headers: { Cookie: cookie } })).json();
  assert.ok(ended.endedAt);
});

test('late final ASR updates saved text and metrics while retaining the exact routing input', async t => {
  let callbacks;
  const { base, socketURL } = await fixture(t, { env: { OPENAI_API_KEY: 'offline-history-key' },
    connect: async options => { callbacks = options; return noOpProvider(options.onEvent); } });
  const cookie = await browserCookie(base);
  const c = await client(t, socketURL, { headers: { Cookie: cookie } });
  c.send({ type: 'start' });
  const saved = await c.wait(event => event.type === 'history');
  await c.wait(event => event.status === 'ready');
  callbacks.onEvent({ type: 'speech_started', itemId: 'input-a' });
  callbacks.onEvent({ type: 'speech_stopped', itemId: 'input-a' });
  const routedText = 'Адрес офиса';
  const decision = { transcript: routedText, scenarios: [{ scenario_id: 'SC33', confidence: .99, reason: 'office request' }],
    alternatives: [], slots: { city: 'Astana' }, language: 'ru', is_continuation: false, confirmation: 'none' };
  await callbacks.onRoute(decision, { turnKey: 'input-a' });
  const trace = await c.wait(event => event.type === 'trace');
  callbacks.onEvent({ type: 'audio', itemId: 'output-a', data: Buffer.alloc(960).toString('base64'), sampleRate: 24000 });
  await c.wait(event => event.type === 'audio');
  c.send({ type: 'playback_started', turnId: trace.turnId });
  const played = await c.wait(event => event.type === 'metrics' && event.latency_ms.end_to_first_audio !== null);
  callbacks.onEvent({ type: 'transcript', role: 'assistant', itemId: 'output-a', text: 'Фактически озвученный ответ', final: true });
  const finalText = 'Подскажите адрес офиса в Астане';
  callbacks.onEvent({ type: 'transcript', role: 'user', itemId: 'input-a', text: finalText, final: true });
  await c.wait(event => event.type === 'transcript' && event.text === finalText);
  const finalMetrics = await c.wait(event => event.type === 'metrics' && event.latency_ms.transcript !== null);
  c.send({ type: 'stop' }); await c.wait(event => event.status === 'stopped');
  const record = await (await fetch(base + '/api/history/' + saved.sessionId, { headers: { Cookie: cookie } })).json();
  assert.equal(record.turns.length, 1);
  const turn = record.turns[0];
  assert.equal(turn.transcript, finalText); assert.equal(turn.trace.transcript, finalText);
  assert.equal(turn.trace.spoken_transcript, 'Фактически озвученный ответ');
  assert.notEqual(turn.reply, turn.trace.spoken_transcript, 'verified reply and actual speech transcript remain separate');
  assert.equal(turn.trace.transcript_source, 'provider');
  assert.equal(turn.trace.decision_transcript, routedText); assert.equal(turn.trace.decision_transcript_source, 'route_tool');
  assert.deepEqual(turn.trace.actions, trace.trace.actions, 'late ASR must not rewrite executed decisions');
  assert.equal(turn.latency.transcript, finalMetrics.latency_ms.transcript);
  assert.equal(turn.latency.end_to_first_audio, played.latency_ms.end_to_first_audio);
  assert.equal(turn.latency.stt, null); assert.equal(turn.latency.tts, null);
});

test('closing a socket permanently discards a queued second start after a delayed provider connect', async t => {
  const history = createHistory({ env: {} });
  const connected = deferred(), release = deferred(), ended = deferred(), providerClosed = deferred();
  let connects = 0, closes = 0;
  const observedHistory = { ...history, endSession: async id => { await history.endSession(id); ended.resolve(); } };
  const { socketURL } = await fixture(t, { env: { OPENAI_API_KEY: 'offline-key' }, history: observedHistory,
    connect: async () => { connects++; connected.resolve(); await release.promise;
      return { close() { closes++; providerClosed.resolve(); }, sendAudio() {}, sendText() {} }; } });
  const c = await client(t, socketURL);
  try {
    c.send({ type: 'start' }); c.send({ type: 'start' });
    await connected.promise;
    c.ws.close(); await ended.promise;
    release.resolve(); await providerClosed.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(connects, 1); assert.equal(closes, 1);
    const sessions = await history.listSessions();
    assert.equal(sessions.length, 1); assert.ok(sessions[0].endedAt);
  } finally { release.resolve(); }
});

test('slow audit start stays off the voice path and session, turn, end writes keep their order', async t => {
  const history = createHistory({ env: {} });
  const release = deferred(), ended = deferred();
  const order = []; let callbacks;
  const observedHistory = { ...history,
    startSession: async record => { await release.promise; order.push('start'); return history.startSession(record); },
    saveTurn: async record => { order.push('turn'); return history.saveTurn(record); },
    endSession: async id => { order.push('end'); await history.endSession(id); ended.resolve(); } };
  const { socketURL } = await fixture(t, { env: { OPENAI_API_KEY: 'offline-key' }, history: observedHistory,
    connect: async options => { callbacks = options; return noOpProvider(options.onEvent); } });
  const c = await client(t, socketURL);
  try {
    c.send({ type: 'start' }); await c.wait(event => event.status === 'ready');
    callbacks.onEvent({ type: 'speech_started', itemId: 'audit-input' });
    await callbacks.onRoute({ transcript: 'Погода', scenarios: [{ scenario_id: 'SYS_OUT_OF_SCOPE', confidence: .99, reason: 'unrelated' }],
      alternatives: [], slots: {}, language: 'ru', is_continuation: false, confirmation: 'none' }, { turnKey: 'audit-input' });
    await c.wait(event => event.type === 'trace');
    assert.deepEqual(order, [], 'database insert is still blocked while the voice turn completes');
    c.send({ type: 'stop' }); await c.wait(event => event.status === 'stopped');
    release.resolve(); await ended.promise;
    assert.deepEqual(order, ['start', 'turn', 'end']);
    const [saved] = await history.listSessions();
    assert.equal(saved.turnCount, 1); assert.ok(saved.endedAt);
  } finally { release.resolve(); }
});

test('runtime audit failure is a nonterminal status even while the voice provider is connecting', async t => {
  let closes = 0;
  const release = deferred();
  const history = { ready: Promise.resolve(), status: { backend: 'postgres', persistent: true, available: false },
    async startSession() { throw new Error('postgresql://user:secret-value@database/voice'); },
    async endSession() {}, async close() {} };
  const { socketURL } = await fixture(t, { env: { OPENAI_API_KEY: 'offline-key' }, history,
    connect: async ({ onEvent }) => { await release.promise; const provider = noOpProvider(onEvent); provider.close = () => { closes++; }; return provider; } });
  const c = await client(t, socketURL);
  try {
    c.send({ type: 'start' });
    const warning = await c.wait(event => event.status === 'history_unavailable');
    assert.equal(warning.type, 'status'); assert.match(warning.message, /историю/);
    assert.ok(!warning.message.includes('secret-value'));
    assert.equal(c.messages.some(event => event.type === 'error' || event.status === 'stopped'), false);
    release.resolve(); await c.wait(event => event.status === 'ready');
    assert.equal(closes, 0);
  } finally { release.resolve(); }
});
