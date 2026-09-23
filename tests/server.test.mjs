import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../server.mjs';

async function fixture(t, options = {}) {
  const app = createApp(options);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());
  return { app, base, socketURL: base.replace('http:', 'ws:') + '/ws' };
}
async function client(t, url) {
  const ws = new WebSocket(url, { origin: url.replace('ws:', 'http:').replace('/ws', '') });
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