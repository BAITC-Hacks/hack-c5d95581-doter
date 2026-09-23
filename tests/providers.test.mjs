import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { connectProvider } from '../lib/providers.mjs';

const schema = { type: 'object', properties: { transcript: { type: 'string' } }, required: ['transcript'] };
const pcm = Buffer.alloc(4800).toString('base64');
const tick = () => new Promise(resolve => setImmediate(resolve));
class Socket extends EventEmitter {
  readyState = 0;
  sent = [];
  send(data) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.emit('open'); }
  server(data) { this.emit('message', Buffer.from(JSON.stringify(data))); }
  close() { this.readyState = 3; this.emit('close', 1000, Buffer.from('closed')); }
}
async function setup(provider = 'openai', overrides = {}) {
  const socket = new Socket(), events = [], routes = [];
  let address, options;
  const promise = connectProvider({ provider, apiKey: 'test-secret-key', instructions: 'Router instructions', toolSchema: schema,
    onEvent: event => events.push(event), onRoute: async args => { routes.push(args); return { reply: 'Проверенный ответ', state: {}, trace: {} }; },
    socketFactory: (url, opts) => { address = url; options = opts; return socket; }, ...overrides });
  socket.open();
  socket.server(provider === 'openai' ? { type: 'session.updated' } : { setupComplete: {} });
  const connection = await promise;
  return { socket, events, routes, connection, address, options };
}
function openAIResponse(socket, id, metadata = undefined) {
  socket.server({ type: 'response.created', response: { id, metadata } });
}
function done(socket, id, output = [], status = 'completed') {
  socket.server({ type: 'response.done', response: { id, output, status } });
}
function call(socket, responseId, id = 'call1', args = '{"transcript":"Привет"}') {
  socket.server({ type: 'response.function_call_arguments.done', response_id: responseId,
    call_id: id, name: 'route_turn', arguments: args });
}

test('OpenAI waits for session.updated, uses GA auth/config and cumulative input transcripts', async () => {
  const socket = new Socket();
  let resolved = false;
  const events = [];
  const pending = connectProvider({ provider: 'openai', apiKey: 'key', toolSchema: schema, onRoute: async () => ({ reply: 'ok' }),
    socketFactory: () => socket, onEvent: event => events.push(event) }).then(value => { resolved = true; return value; });
  socket.open(); socket.server({ type: 'session.created' }); await tick();
  assert.equal(resolved, false);
  const config = socket.sent[0].session;
  assert.equal(config.type, 'realtime'); assert.equal(config.tool_choice, 'required');
  assert.equal(config.audio.input.format.rate, 24000);
  assert.equal(config.audio.input.transcription.model, 'gpt-transcribe');
  socket.server({ type: 'session.updated' });
  const connection = await pending;
  socket.server({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'u1', delta: 'Сәлем' });
  socket.server({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'u1', delta: ', hello' });
  socket.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Сәлем, hello!' });
  assert.deepEqual(events.filter(x => x.type === 'transcript').map(x => [x.text, x.final]),
    [['Сәлем', false], ['Сәлем, hello', false], ['Сәлем, hello!', true]]);
  connection.close();
});

test('OpenAI gates audio until route completes, deduplicates calls, and speaks without tool loops', async () => {
  const { socket, events, routes, connection } = await setup();
  connection.sendText('Привет'); openAIResponse(socket, 'r1');
  socket.server({ type: 'response.output_audio.delta', response_id: 'r1', item_id: 'a0', delta: pcm });
  assert.equal(events.filter(x => x.type === 'audio').length, 0);
  call(socket, 'r1'); call(socket, 'r1'); await tick();
  assert.equal(routes.length, 1);
  assert.equal(socket.sent.filter(x => x.type === 'response.create').length, 1, 'wait for route response.done');
  done(socket, 'r1', [{ type: 'function_call', call_id: 'call1', name: 'route_turn', arguments: '{"transcript":"Привет"}' }]);
  const speech = socket.sent.filter(x => x.type === 'response.create').at(-1).response;
  assert.equal(speech.tool_choice, 'none'); assert.match(speech.instructions, /Проверенный ответ/);
  openAIResponse(socket, 'r2', speech.metadata);
  socket.server({ type: 'response.output_audio.delta', response_id: 'r2', item_id: 'a2', delta: pcm });
  socket.server({ type: 'response.output_audio_transcript.delta', response_id: 'r2', item_id: 'a2', delta: 'Проверенный' });
  socket.server({ type: 'response.output_audio_transcript.delta', response_id: 'r2', item_id: 'a2', delta: ' ответ' });
  assert.equal(events.filter(x => x.type === 'audio').length, 1);
  assert.equal(events.filter(x => x.role === 'assistant').at(-1).text, 'Проверенный ответ');
  assert.equal(events.find(x => x.type === 'audio').itemId, 'a2');
  connection.close();
});

test('OpenAI malformed tool JSON never reaches router and produces safe clarification', async () => {
  const { socket, events, routes, connection } = await setup();
  openAIResponse(socket, 'r1'); call(socket, 'r1', 'bad', '{broken'); done(socket, 'r1'); await tick();
  assert.equal(routes.length, 0);
  assert.ok(events.some(x => x.type === 'error'));
  const output = socket.sent.find(x => x.item?.type === 'function_call_output');
  assert.equal(JSON.parse(output.item.output).error, 'route_failed');
  assert.match(socket.sent.at(-1).response.instructions, /повторите/);
  connection.close();
});

test('OpenAI barge-in truncates to actual reported playback and drops stale tool results', async () => {
  let finish;
  const { socket, events, connection } = await setup('openai', { onRoute: () => new Promise(resolve => { finish = resolve; }) });
  openAIResponse(socket, 'r1'); call(socket, 'r1'); done(socket, 'r1');
  socket.server({ type: 'input_audio_buffer.speech_started', item_id: 'u2' });
  finish({ reply: 'STALE' }); await tick();
  assert.equal(socket.sent.filter(x => x.item?.type === 'function_call_output').length, 0);
  connection.speak('Подтверждено');
  const payload = socket.sent.at(-1).response;
  openAIResponse(socket, 'r2', payload.metadata);
  socket.server({ type: 'response.output_audio.delta', response_id: 'r2', item_id: 'a2', delta: pcm });
  connection.reportPlayback({ itemId: 'a2', audioEndMs: 35 });
  socket.server({ type: 'input_audio_buffer.speech_started', item_id: 'u3' });
  const truncate = socket.sent.find(x => x.type === 'conversation.item.truncate');
  assert.deepEqual(truncate, { type: 'conversation.item.truncate', item_id: 'a2', content_index: 0, audio_end_ms: 35 });
  const count = events.filter(x => x.type === 'audio').length;
  socket.server({ type: 'response.output_audio.delta', response_id: 'r2', item_id: 'a2', delta: pcm });
  assert.equal(events.filter(x => x.type === 'audio').length, count);
  assert.ok(events.some(x => x.type === 'speech_started'));
  connection.close();
});

test('OpenAI text and confirmation methods share session and send valid audio', async () => {
  const { socket, connection, options } = await setup();
  assert.equal(options.headers.Authorization, 'Bearer test-secret-key');
  assert.equal(options.headers['OpenAI-Beta'], undefined);
  connection.sendAudio(pcm);
  assert.deepEqual(socket.sent.at(-1), { type: 'input_audio_buffer.append', audio: pcm });
  assert.throws(() => connection.sendAudio('not pcm'), /PCM16/);
  connection.speak('Бронь отменена');
  assert.equal(socket.sent.at(-1).response.tool_choice, 'none');
  connection.close(); assert.throws(() => connection.sendText('test'), /not ready/);
});

test('Gemini uses the raw wire setup schema, native rates, and setup acknowledgment', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { socket, connection, events, address } = await setup('gemini');
  const config = socket.sent[0].setup;
  assert.equal(config.model, 'models/gemini-3.8-live');
  assert.deepEqual(config.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(config.responseModalities, undefined);
  assert.deepEqual(config.tools[0].functionDeclarations[0].parametersJsonSchema, schema);
  assert.match(address, /v1beta\.GenerativeService\.BidiGenerateContent/);
  assert.equal(events.find(x => x.status === 'ready').inputSampleRate, 16000);
  connection.sendAudio(pcm);
  assert.equal(socket.sent.at(-1).realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  connection.endAudio(); for (let frame = 0; frame < 20; frame++) t.mock.timers.tick(40);
  assert.deepEqual(socket.sent.at(-1), { realtimeInput: { audioStreamEnd: true } });
  connection.close();
});

test('Gemini deduplicates tools, gates audio, and accumulates transcript until turn completion', async () => {
  const { socket, events, routes, connection } = await setup('gemini');
  const audio = { modelTurn: { parts: [{ inlineData: { data: pcm, mimeType: 'audio/pcm;rate=24000' } }] } };
  socket.server({ serverContent: { ...audio, outputTranscription: { text: 'unvalidated' } } });
  assert.equal(events.filter(x => x.type === 'audio').length, 0);
  socket.server({ serverContent: { inputTranscription: { text: 'Тариф ' } } });
  socket.server({ serverContent: { inputTranscription: { text: 'какой?' } } });
  const tool = { toolCall: { functionCalls: [{ id: 'g1', name: 'route_turn', args: { transcript: 'Тариф какой?' } }] } };
  socket.server(tool); socket.server(tool); await tick();
  assert.equal(routes.length, 1);
  assert.equal(socket.sent.filter(x => x.toolResponse).length, 1);
  assert.equal(socket.sent.at(-1).toolResponse.functionResponses[0].id, 'g1');
  socket.server({ serverContent: { ...audio, outputTranscription: { text: 'Ответ' } } });
  socket.server({ serverContent: { turnComplete: true } });
  assert.equal(events.filter(x => x.type === 'audio').length, 1);
  assert.deepEqual(events.filter(x => x.type === 'transcript' && x.final).map(x => [x.role, x.text]), [['user', 'Тариф какой?'], ['assistant', 'Ответ']]);
  assert.equal(events.some(x => x.type === 'speech_stopped'), false, 'do not invent Gemini input-end timing');
  socket.server({ serverContent: audio });
  assert.equal(events.filter(x => x.type === 'audio').length, 1, 'gate closes at end of turn');
  connection.close();
});

test('Gemini canceled tool completion cannot release stale audio or mutate again', async () => {
  let finish, count = 0;
  const { socket, events, connection } = await setup('gemini', { onRoute: () => { count++; return new Promise(resolve => { finish = resolve; }); } });
  const tool = { toolCall: { functionCalls: [{ id: 'g1', name: 'route_turn', args: {} }] } };
  socket.server(tool);
  socket.server({ toolCallCancellation: { ids: ['g1'] } });
  finish({ reply: 'STALE' }); await tick(); socket.server(tool);
  assert.equal(count, 1); assert.equal(socket.sent.filter(x => x.toolResponse).length, 0);
  assert.ok(events.some(x => x.type === 'interrupt'));
  connection.close();
});

test('Setup errors, transport close, malformed messages, and timeout reject without leaking keys', async () => {
  for (const mode of ['error', 'close', 'malformed', 'timeout']) {
    const socket = new Socket(), events = [];
    const promise = connectProvider({ provider: 'gemini', apiKey: 'secret/a+b', toolSchema: schema, onRoute: async () => ({ reply: 'ok' }),
      socketFactory: () => socket, connectTimeoutMs: 10, onEvent: event => events.push(event) });
    socket.open();
    const leak = 'wss://example.test?key=secret%2Fa%2Bb secret/a+b Bearer other-secret';
    if (mode === 'error') socket.emit('error', new Error(leak));
    else if (mode === 'close') socket.emit('close', 1008, Buffer.from(leak));
    else if (mode === 'malformed') socket.emit('message', Buffer.from('{bad'));
    await assert.rejects(promise, error => !/secret\/a|secret%2F|other-secret/.test(error.message));
    assert.doesNotMatch(JSON.stringify(events), /secret\/a|secret%2F|other-secret/);
    assert.equal(socket.readyState, 3);
  }
});

test('Gemini direct server confirmation cannot invoke business routing', async () => {
  const { socket, routes, connection } = await setup('gemini');
  connection.speak('Изменение подтверждено');
  socket.server({ toolCall: { functionCalls: [{ id: 'confirm', name: 'route_turn', args: {} }] } });
  await tick();
  assert.equal(routes.length, 0);
  assert.equal(socket.sent.at(-1).toolResponse.functionResponses[0].response.reply, 'Изменение подтверждено');
  connection.close();
});

test('Gemini turn keys distinguish consecutive voice turns even when tools precede transcripts', async () => {
  const seen = [];
  const { socket, connection, events } = await setup('gemini', { onRoute: async (args, context) => {
    seen.push({ args, context }); return { reply: 'Ответ' };
  } });
  socket.server({ toolCall: { functionCalls: [{ id: 'one', name: 'route_turn', args: { transcript: 'Первый' } }] } });
  await tick();
  socket.server({ serverContent: { inputTranscription: { text: 'Первый' },
    modelTurn: { parts: [{ inlineData: { data: pcm, mimeType: 'audio/pcm;rate=24000' } }] }, turnComplete: true } });
  socket.server({ toolCall: { functionCalls: [{ id: 'two', name: 'route_turn', args: { transcript: 'Второй' } }] } });
  await tick();
  assert.deepEqual(events.filter(x => x.type === 'turn_started').map(x => [x.turnKey, x.source]), [['gemini-1', 'audio'], ['gemini-2', 'audio']]);
  assert.deepEqual(seen.map(x => x.context.turnKey), ['gemini-1', 'gemini-2']);
  assert.equal(events.find(x => x.role === 'user').turnKey, 'gemini-1');
  connection.sendText('Третий');
  assert.equal(events.filter(x => x.type === 'turn_started').at(-1).source, 'text');
  connection.close();
});

test('Gemini server confirmation survives the interrupted previous generation boundary', async () => {
  const { socket, connection, events } = await setup('gemini');
  socket.server({ toolCall: { functionCalls: [{ id: 'one', name: 'route_turn', args: {} }] } });
  await tick();
  connection.speak('Подтверждено');
  const audio = { modelTurn: { parts: [{ inlineData: { data: pcm, mimeType: 'audio/pcm;rate=24000' } }] } };
  socket.server({ serverContent: audio });
  assert.equal(events.filter(x => x.type === 'audio').length, 0, 'old generation is suppressed');
  socket.server({ serverContent: { interrupted: true } });
  socket.server({ serverContent: { turnComplete: true } });
  socket.server({ serverContent: audio });
  assert.equal(events.filter(x => x.type === 'audio').length, 1, 'validated new generation can speak');
  connection.close();
});


test('Gemini text barge-in consumes the previous generation boundary without replacing the text turn', async () => {
  const seen = [];
  const { socket, connection, events } = await setup('gemini', { onRoute: async (args, context) => {
    seen.push({ args, context }); return { reply: 'Проверенный ответ' };
  } });
  const audio = { modelTurn: { parts: [{ inlineData: { data: pcm, mimeType: 'audio/pcm;rate=24000' } }] } };
  const tool = (id, transcript) => ({ toolCall: { functionCalls: [{ id, name: 'route_turn', args: { transcript } }] } });
  socket.server(tool('first', 'Первый'));
  await tick();
  socket.server({ serverContent: { ...audio, outputTranscription: { text: 'Первый ответ' } } });
  assert.equal(events.filter(x => x.type === 'audio').length, 1);

  connection.sendText('Новый запрос');
  const textTurn = events.filter(x => x.type === 'turn_started').at(-1);
  const eventStart = events.length;
  socket.server({ serverContent: { ...audio, inputTranscription: { text: 'старый ввод' }, outputTranscription: { text: 'старый ответ' } } });
  socket.server(tool('obsolete', 'Запоздалый вызов'));
  socket.server({ toolCallCancellation: { ids: ['first'] } });
  socket.server({ serverContent: { interrupted: true } });
  socket.server({ serverContent: { ...audio, turnComplete: true } });
  await tick();
  assert.equal(seen.length, 1, 'obsolete tool calls cannot execute during the boundary');
  assert.equal(events.filter(x => x.type === 'audio').length, 1, 'old generation cannot release audio');
  assert.equal(events.slice(eventStart).some(x => x.type === 'interrupt'), false, 'old interruption must not target the new text turn');
  assert.equal(events.slice(eventStart).some(x => x.type === 'transcript'), false, 'old transcripts cannot contaminate the new turn');

  socket.server(tool('obsolete', 'Запоздалый вызов'));
  socket.server(tool('fresh', 'Новый запрос'));
  socket.server(tool('fresh', 'Новый запрос'));
  await tick();
  socket.server({ serverContent: { ...audio, outputTranscription: { text: 'Новый ' } } });
  socket.server({ serverContent: { outputTranscription: { text: 'ответ' } } });
  socket.server({ serverContent: { turnComplete: true } });
  assert.deepEqual(events.filter(x => x.type === 'turn_started').map(x => [x.turnKey, x.source]),
    [['gemini-1', 'audio'], ['gemini-2', 'text']]);
  assert.equal(textTurn.turnKey, 'gemini-2');
  assert.deepEqual(seen.map(x => [x.args.transcript, x.context.turnKey]), [['Первый', 'gemini-1'], ['Новый запрос', 'gemini-2']]);
  assert.deepEqual(socket.sent.filter(x => x.toolResponse).map(x => x.toolResponse.functionResponses[0].id), ['first', 'fresh']);
  assert.equal(events.filter(x => x.type === 'audio').length, 2);
  assert.equal(events.filter(x => x.type === 'audio').at(-1).turnKey, textTurn.turnKey);
  assert.deepEqual(events.slice(eventStart).filter(x => x.role === 'assistant').map(x => [x.text, x.final, x.turnKey]),
    [['Новый ', false, textTurn.turnKey], ['Новый ответ', false, textTurn.turnKey], ['Новый ответ', true, textTurn.turnKey]]);
  assert.equal(events.some(x => x.type === 'speech_stopped'), false);
  connection.close();
});

test('OpenAI requests playback cutoff synchronously before truncating the conversation', async () => {
  let current;
  const observed = [];
  const { socket, connection } = await setup('openai', { onEvent: event => {
    observed.push(event.type);
    if (event.type === 'playback_cutoff_request' && current) current.reportPlayback({ itemId: 'spoken', audioEndMs: 42 });
  } });
  current = connection;
  connection.speak('Ответ');
  openAIResponse(socket, 'speech', socket.sent.at(-1).response.metadata);
  socket.server({ type: 'response.output_audio.delta', response_id: 'speech', item_id: 'spoken', delta: pcm });
  const eventStart = observed.length;
  socket.server({ type: 'input_audio_buffer.speech_started', item_id: 'next' });
  assert.deepEqual(observed.slice(eventStart, eventStart + 2), ['playback_cutoff_request', 'interrupt']);
  assert.equal(socket.sent.find(x => x.type === 'conversation.item.truncate').audio_end_ms, 42);
  connection.close();
});


test('Gemini preserves a routed turn across tool-only completion before asynchronous reply audio', async () => {
  let finish;
  const { socket, events, connection } = await setup('gemini', {
    onRoute: () => new Promise(resolve => { finish = resolve; }),
  });
  connection.sendText('Стоимость ОГПО');
  const turnKey = events.filter(event => event.type === 'turn_started').at(-1).turnKey;
  socket.server({ toolCall: { functionCalls: [{ id: 'route', name: 'route_turn', args: { transcript: 'Стоимость ОГПО' } }] } });
  socket.server({ serverContent: { generationComplete: true } });
  socket.server({ serverContent: { turnComplete: true } });
  const audio = { modelTurn: { parts: [{ inlineData: { data: pcm, mimeType: 'audio/pcm;rate=24000' } }] } };
  socket.server({ serverContent: audio });
  assert.equal(events.filter(event => event.type === 'audio').length, 0, 'router must finish before any audio is allowed');
  finish({ reply: 'Уточните город' }); await tick();
  assert.equal(socket.sent.filter(event => event.toolResponse).length, 1);
  socket.server({ serverContent: { ...audio, outputTranscription: { text: 'Уточните город' } } });
  socket.server({ serverContent: { turnComplete: true } });
  assert.equal(events.filter(event => event.type === 'audio').length, 1);
  assert.equal(events.find(event => event.type === 'audio').turnKey, turnKey);
  assert.equal(events.filter(event => event.type === 'turn_started').length, 1);
  assert.equal(events.filter(event => event.type === 'error').length, 0);
  assert.equal(events.find(event => event.role === 'assistant' && event.final).text, 'Уточните город');
  socket.server({ serverContent: audio });
  assert.equal(events.filter(event => event.type === 'audio').length, 1, 'the final spoken generation closes the gate');
  connection.close();
});

test('Gemini interruption after tool-only completion invalidates the pending route result', async () => {
  let finish;
  const { socket, events, connection } = await setup('gemini', {
    onRoute: () => new Promise(resolve => { finish = resolve; }),
  });
  socket.server({ toolCall: { functionCalls: [{ id: 'route', name: 'route_turn', args: {} }] } });
  socket.server({ serverContent: { turnComplete: true } });
  socket.server({ serverContent: { interrupted: true } });
  finish({ reply: 'STALE' }); await tick();
  socket.server({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm, mimeType: 'audio/pcm;rate=24000' } }] } } });
  assert.equal(socket.sent.filter(event => event.toolResponse).length, 0);
  assert.equal(events.filter(event => event.type === 'audio').length, 0);
  connection.close();
});


test('Gemini toolResponse followed by tool-only turnComplete retains authorization for its audio generation', async () => {
  const { socket, events, routes, connection } = await setup('gemini');
  connection.sendText('Стоимость ОГПО');
  socket.server({ toolCall: { functionCalls: [{ id: 'route', name: 'route_turn', args: { transcript: 'Стоимость ОГПО' } }] } });
  await tick();
  assert.equal(socket.sent.filter(event => event.toolResponse).length, 1);
  socket.server({ serverContent: { generationComplete: true } });
  socket.server({ serverContent: { turnComplete: true } });
  socket.server({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm, mimeType: 'audio/pcm;rate=24000' } }] },
    outputTranscription: { text: 'Проверенный ответ' } } });
  socket.server({ serverContent: { turnComplete: true } });
  assert.equal(routes.length, 1);
  assert.equal(events.filter(event => event.type === 'audio').length, 1);
  assert.equal(events.filter(event => event.type === 'error').length, 0);
  assert.equal(events.find(event => event.role === 'assistant' && event.final).text, 'Проверенный ответ');
  connection.close();
});


test('OpenAI audio_done waits for current completed speech and excludes route, canceled, and stale responses', async () => {
  const { socket, events, connection } = await setup();
  connection.speak('Синтетический образец');
  const metadata = socket.sent.at(-1).response.metadata;
  openAIResponse(socket, 'speech-ok', metadata);
  socket.server({ type: 'response.output_audio.delta', response_id: 'speech-ok', item_id: 'a1', delta: pcm });
  socket.server({ type: 'response.output_audio_transcript.done', response_id: 'speech-ok', item_id: 'a1', transcript: 'Синтетический образец' });
  assert.equal(events.filter(x => x.type === 'audio_done').length, 0, 'transcript final alone is not the audio completion boundary');
  socket.server({ type: 'response.output_audio.delta', response_id: 'speech-ok', item_id: 'a1', delta: pcm });
  done(socket, 'speech-ok');
  assert.equal(events.filter(x => x.type === 'audio').length, 2, 'tail audio is retained');
  assert.deepEqual(events.filter(x => x.type === 'audio_done'), [{ type: 'audio_done', responseId: 'speech-ok' }]);

  connection.speak('Отменённый образец');
  openAIResponse(socket, 'speech-canceled', socket.sent.at(-1).response.metadata);
  done(socket, 'speech-canceled', [], 'cancelled');
  connection.speak('Устаревший образец');
  openAIResponse(socket, 'speech-stale', socket.sent.at(-1).response.metadata);
  connection.interrupt();
  done(socket, 'speech-stale');
  openAIResponse(socket, 'route-only', { voice_router_kind: 'route', voice_router_epoch: '0' });
  done(socket, 'route-only');
  assert.equal(events.filter(x => x.type === 'audio_done').length, 1);
  connection.close();
});


test('Gemini capture stop sends a bounded paced silence tail before flushing and ignores duplicate stops', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { socket, connection } = await setup('gemini');
  connection.sendAudio(pcm);
  const before = socket.sent.length;
  connection.endAudio(); connection.endAudio();
  assert.equal(socket.sent.length, before + 1);
  assert.equal(socket.sent.some(event => event.realtimeInput?.audioStreamEnd), false);
  for (let frame = 1; frame < 20; frame++) {
    t.mock.timers.tick(40);
    assert.equal(socket.sent.length, before + frame + 1, 'silence is paced at 40ms');
  }
  const tail = socket.sent.slice(before);
  assert.equal(tail.length, 20);
  assert.ok(tail.every(event => event.realtimeInput.audio.mimeType === 'audio/pcm;rate=16000'));
  assert.ok(tail.every(event => Buffer.from(event.realtimeInput.audio.data, 'base64').equals(Buffer.alloc(1280))));
  assert.equal(socket.sent.some(event => event.realtimeInput?.audioStreamEnd), false);
  t.mock.timers.tick(40);
  assert.deepEqual(socket.sent.at(-1), { realtimeInput: { audioStreamEnd: true } });
  connection.endAudio(); t.mock.timers.tick(1000);
  assert.equal(socket.sent.length, before + 21, 'duplicate stop cannot restart a completed tail');
  connection.close();
});

test('Gemini resumed audio, text, interrupt, and close cancel pending silence without a later stream-end', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of ['audio', 'text', 'interrupt', 'close']) {
    const { socket, connection } = await setup('gemini');
    connection.sendAudio(pcm); connection.endAudio(); t.mock.timers.tick(80);
    if (action === 'audio') connection.sendAudio(pcm);
    if (action === 'text') connection.sendText('Новая реплика');
    if (action === 'interrupt') connection.interrupt();
    if (action === 'close') connection.close();
    const count = socket.sent.length;
    t.mock.timers.tick(1000);
    assert.equal(socket.sent.length, count, action + ' must invalidate the old tail timer');
    assert.equal(socket.sent.some(event => event.realtimeInput?.audioStreamEnd), false, action + ' must not flush a newer stream');
    connection.close();
  }
});


test('Gemini delayed upstream output interruption preserves the current input silence tail', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const upstream of [{ serverContent: { interrupted: true } }, { toolCallCancellation: { ids: ['old-output-call'] } }]) {
    const { socket, connection, events } = await setup('gemini');
    connection.sendAudio(pcm);
    connection.endAudio();
    t.mock.timers.tick(40); t.mock.timers.tick(40);
    socket.server(upstream);
    for (let frame = 0; frame < 18; frame++) t.mock.timers.tick(40);
    assert.equal(events.filter(event => event.type === 'interrupt').length, 1, 'old output is still invalidated');
    assert.equal(socket.sent.filter(event => event.realtimeInput?.audioStreamEnd).length, 1, 'current input still flushes');
    assert.equal(socket.sent.filter(event => event.realtimeInput?.audio).length, 21, 'input plus all 20 silence frames');
    const sent = socket.sent.length;
    t.mock.timers.tick(1000);
    assert.equal(socket.sent.length, sent, 'flush happens only once');
    connection.close();
  }
});


test('Ready provider transport failures emit one fatal error with credentials redacted', async () => {
  const secret = 'secret/a+b';
  for (const provider of ['openai', 'gemini']) for (const mode of ['close', 'error']) {
    const { socket, events, connection } = await setup(provider, { apiKey: secret });
    const reason = 'Disconnected key=' + secret + ' ?key=' + encodeURIComponent(secret) + ' Bearer another-secret';
    if (mode === 'close') socket.emit('close', 1008, Buffer.from(reason));
    else socket.emit('error', new Error(reason));
    socket.emit('close', 1008, Buffer.from(reason));
    const errors = events.filter(event => event.type === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].fatal, true);
    assert.doesNotMatch(errors[0].message, /secret\/a|secret%2F|another-secret/);
    assert.equal(socket.readyState, 3);
    assert.throws(() => connection.sendText('Next'), /not ready/);
  }
});

test('Route callback failures remain recoverable for both voice providers', async () => {
  for (const provider of ['openai', 'gemini']) {
    const { socket, events, connection } = await setup(provider, { onRoute: async () => { throw new Error('Route validation failed'); } });
    if (provider === 'openai') {
      openAIResponse(socket, 'route'); call(socket, 'route'); done(socket, 'route');
    } else socket.server({ toolCall: { functionCalls: [{ id: 'route', name: 'route_turn', args: {} }] } });
    await tick();
    const errors = events.filter(event => event.type === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].fatal, undefined);
    assert.equal(socket.readyState, 1);
    connection.close();
  }
});

test('Gemini merges transcript deltas and growing hypotheses without discarding repeated fragments', async () => {
  for (const { chunks, expected } of [
    { chunks: ['Hello ', 'world'], expected: 'Hello world' },
    { chunks: ['Hello ', 'Hello world'], expected: 'Hello world' },
    { chunks: ['go ', 'go '], expected: 'go go ' },
  ]) {
    const { socket, events, connection } = await setup('gemini');
    for (const [index, text] of chunks.entries()) {
      socket.server({ serverContent: { inputTranscription: { text, finished: index === chunks.length - 1 } } });
    }
    assert.deepEqual(events.filter(event => event.role === 'user').map(event => [event.text, event.final]),
      [[chunks[0], false], [expected, true]]);
    socket.server({ toolCall: { functionCalls: [{ id: 'route', name: 'route_turn', args: {} }] } });
    await tick();
    for (const text of chunks) socket.server({ serverContent: { outputTranscription: { text } } });
    socket.server({ serverContent: { turnComplete: true } });
    assert.equal(events.filter(event => event.role === 'user' && event.final).length, 1, 'finished is already the final transcript');
    assert.equal(events.find(event => event.role === 'assistant' && event.final).text, expected);
    assert.equal(events.some(event => event.type === 'speech_stopped'), false, 'transcript completion must not invent a VAD event');
    connection.close();
  }
});

test('Gemini combined input, tool call, and completion keep one turn until the asynchronous tool result', async () => {
  let finish;
  const routed = [];
  const { socket, events, connection } = await setup('gemini', { onRoute: (args, context) => {
    routed.push({ args, context }); return new Promise(resolve => { finish = resolve; });
  } });
  const audio = { modelTurn: { parts: [{ inlineData: { data: pcm, mimeType: 'audio/pcm;rate=24000' } }] } };
  socket.server({ serverContent: { inputTranscription: { text: 'Нужна стоимость' }, ...audio, turnComplete: true },
    toolCall: { functionCalls: [{ id: 'combined', name: 'route_turn', args: { transcript: 'Нужна стоимость' } }] } });
  assert.equal(routed.length, 1);
  assert.equal(routed[0].context.turnKey, 'gemini-1');
  assert.deepEqual(events.filter(event => event.type === 'turn_started').map(event => event.turnKey), ['gemini-1']);
  assert.equal(events.filter(event => event.type === 'audio').length, 0, 'combined audio cannot bypass the pending tool');
  finish({ reply: 'Уточните город' }); await tick();
  socket.server({ serverContent: { ...audio, outputTranscription: { text: 'Уточните город' }, turnComplete: true } });
  assert.equal(events.filter(event => event.type === 'audio').length, 1);
  assert.deepEqual(events.filter(event => event.role === 'user' && event.final).map(event => [event.text, event.turnKey]),
    [['Нужна стоимость', 'gemini-1']]);
  assert.equal(events.find(event => event.role === 'assistant' && event.final).turnKey, 'gemini-1');
  assert.equal(events.filter(event => event.type === 'error').length, 0);
  connection.close();
});
