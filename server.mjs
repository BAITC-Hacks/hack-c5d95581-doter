import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { loadData, publicCatalog } from './lib/catalog.mjs';
import { buildInstructions, makeToolSchema } from './lib/prompts.mjs';
import { createSession, processTurn } from './lib/engine.mjs';
import { connectProvider } from './lib/providers.mjs';
import { discoverModels } from './lib/models.mjs';
import { providerGuidance, withModelGuidance } from './lib/model-guidance.mjs';

const publicRoot = path.resolve(fileURLToPath(new URL('./public/', import.meta.url)));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const monotonic = () => performance.now();
const rounded = n => Number.isFinite(n) && n >= 0 ? Math.round(n) : null;

export function createApp({ data = loadData(), connect = connectProvider, env = process.env, modelDiscovery = discoverModels } = {}) {
  const settings = {
    openai: { apiKey: env.OPENAI_API_KEY || '', model: env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1', inputSampleRate: 24000 },
    gemini: { apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '', model: env.GEMINI_LIVE_MODEL || 'gemini-3.8-live', inputSampleRate: 16000 },
  };
  const config = { providers: Object.fromEntries(Object.entries(settings).map(([name, s]) => [name, { configured: Boolean(s.apiKey.trim()), model: s.model, models: withModelGuidance([{ id: s.model, label: s.model }]), guidance: providerGuidance(name), verified: false }])), catalog: publicCatalog(data), asOfDate: data.scenarios.meta.as_of_date };
  const instructions = buildInstructions(data);
  const toolSchema = makeToolSchema(data);
  const active = new Set();
  function safeError(error) {
    let message = String(error?.message || error || 'Неизвестная ошибка').slice(0, 1200);
    for (const s of Object.values(settings)) if (s.apiKey) message = message.split(s.apiKey).join('[redacted]');
    return message.replace(/(key=|Bearer\s+|sk-)[^\s&"']+/gi, '$1[redacted]');
  }
  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  }
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { return json(res, 400, { error: 'Invalid URL' }); }
    if (pathname === '/api/config') return json(res, 200, config);
    if (pathname === '/api/health') return json(res, 200, { status: 'ok', scenarios: 40, api: config.providers });
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const target = path.resolve(publicRoot, relative);
    if (target !== publicRoot && !target.startsWith(publicRoot + path.sep)) return json(res, 403, { error: 'Forbidden' });
    if (relative.includes('\0') || !mime[path.extname(target)]) return json(res, 404, { error: 'Not found' });
    try {
      const content = await readFile(target);
      res.writeHead(200, { 'Content-Type': mime[path.extname(target)], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'microphone=(self), camera=()', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch { json(res, 404, { error: 'Not found' }); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    let allowed = false;
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const origin = req.headers.origin;
      allowed = pathname === '/ws' && (!origin || new URL(origin).host === req.headers.host);
    } catch { /* malformed origin */ }
    if (!allowed) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  wss.on('connection', ws => {
    let session = createSession(data, { id: randomUUID() });
    let connection = null;
    let provider = 'openai';
    let generation = 0;
    let started = false;
    let turnCounter = 0;
    let current = null;
    let lastDecision = null;
    let routeCalls = 0;
    let commandQueue = Promise.resolve();
    let suppressProviderInterrupt = false;
    const turns = new Map();
    const providerTurns = new Map();
    const send = event => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 4 * 1024 * 1024) { stop(); ws.close(1013, 'Slow client'); return; }
      ws.send(JSON.stringify(event));
    };
    const fail = error => send({ type: 'error', message: safeError(error) });
    function beginTurn(text = '') {
      const id = `turn-${++turnCounter}`;
      current = { id, started: monotonic(), end: null, transcriptAt: null, text, routed: false, route: null, backend: null, playback: null, audioItem: null, firstAudio: null, userFinal: false };
      turns.set(id, current);
      if (turns.size > 50) turns.delete(turns.keys().next().value);
      routeCalls = 0;
      return current;
    }
    function metrics(turn) {
      return {
        route: rounded(turn.route), backend: rounded(turn.backend),
        transcript: turn.end !== null && turn.transcriptAt !== null ? rounded(turn.transcriptAt - turn.end) : null,
        end_to_first_audio: turn.end !== null && turn.playback !== null ? rounded(turn.playback - turn.end) : null,
        stt: null, tts: null,
      };
    }
    function stop() {
      generation++;
      started = false;
      const old = connection;
      connection = null;
      old?.close();
      current = null;
    }
    active.add(stop);
    async function start(name, requestedModel) {
      if (!Object.hasOwn(settings, name)) throw new Error('Выберите OpenAI или Gemini.');
      stop();
      provider = name;
      const selectedModel = requestedModel || config.providers[provider].model;
      if (!config.providers[provider].models.some(m => m.id === selectedModel)) throw new Error('Выбранная модель недоступна в списке этого провайдера.');
      const s = { ...settings[provider], model: selectedModel };
      if (!s.apiKey.trim()) throw new Error(`Для ${provider === 'openai' ? 'OpenAI' : 'Gemini'} не настроен ${provider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY'}. Добавьте ключ в локальный .env и перезапустите сервер.`);
      session = createSession(data, { id: randomUUID() });
      lastDecision = null;
      turns.clear();
      providerTurns.clear();
      turnCounter = 0;
      started = true;
      const token = generation;
      send({ type: 'status', status: 'connecting', provider, inputSampleRate: s.inputSampleRate, outputSampleRate: 24000 });
      const conn = await connect({
        provider, apiKey: s.apiKey, model: s.model, instructions, toolSchema,
        onEvent(event) {
          if (token !== generation || !started) return;
          if (event.type === 'playback_cutoff_request') {
            if (current?.playback !== null && current?.audioItem) connection?.reportPlayback?.({ itemId: current.audioItem, audioEndMs: Math.max(0, monotonic() - current.playback) });
            return;
          }
          if (event.type === 'turn_started') {
            const turn = event.source === 'text' && current && !current.routed ? current : beginTurn();
            if (event.turnKey) providerTurns.set(event.turnKey, turn);
            return;
          }
          if (event.type === 'speech_started') {
            const turn = beginTurn();
            if (event.itemId) providerTurns.set(event.itemId, turn);
            return;
          }
          const eventTurn = providerTurns.get(event.turnKey || event.itemId) || current;
          if (event.type === 'speech_stopped') {
            const turn = eventTurn || beginTurn();
            turn.end = monotonic();
          } else if (event.type === 'interrupt') {
            if (suppressProviderInterrupt) return;
            send({ type: 'interrupt', turnId: eventTurn?.id });
          } else if (event.type === 'status') {
            send({ ...event, provider, inputSampleRate: s.inputSampleRate, outputSampleRate: 24000 });
          } else if (event.type === 'transcript') {
            const turn = eventTurn || beginTurn();
            if (event.role === 'user') {
              turn.text = event.text;
              turn.userFinal = Boolean(event.final);
              if (event.final && turn.transcriptAt === null) turn.transcriptAt = monotonic();
            }
            send({ ...event, turnId: turn.id });
            if (event.final) send({ type: 'metrics', turnId: turn.id, latency_ms: metrics(turn) });
          } else if (event.type === 'audio') {
            if (!eventTurn?.routed || eventTurn !== current) return;
            if (eventTurn.firstAudio === null) eventTurn.firstAudio = monotonic();
            if (event.itemId) { eventTurn.audioItem = event.itemId; providerTurns.set(event.itemId, eventTurn); }
            send({ ...event, turnId: eventTurn.id });
          } else if (event.type === 'error') {
            fail(event.message);
            if (event.fatal) {
              stop();
              send({ type: 'status', status: 'stopped', provider });
            }
          }
        },
        async onRoute(decision, context = {}) {
          if (token !== generation || !started) return { reply: '', trace: {}, state: {} };
          if (!current) beginTurn();
          const turn = context.turnKey ? providerTurns.get(context.turnKey) : current;
          if (!turn || turn !== current) return { reply: '', trace: {}, state: {} };
          if (++routeCalls > 1) return { reply: 'Дождитесь следующей реплики клиента.', trace: {}, state: {} };
          if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new Error('Модель вернула некорректный маршрут. Повторите запрос.');
          const utterance = turn.userFinal && turn.text ? turn.text : (typeof decision.transcript === 'string' ? decision.transcript : turn.text || '');
          if (!turn.text && utterance) {
            turn.text = utterance;
            send({ type: 'transcript', role: 'user', text: utterance, final: true, turnId: turn.id, source: 'route_tool' });
          }
          turn.route = turn.end === null ? null : monotonic() - turn.end;
          const t0 = monotonic();
          const result = processTurn(session, decision, { turnId: turn.id, transcript: utterance });
          turn.backend = monotonic() - t0;
          turn.routed = true;
          lastDecision = structuredClone(decision);
          result.trace.transcript = utterance;
          result.trace.transcript_source = turn.userFinal ? 'provider' : 'route_tool';
          send({ type: 'trace', turnId: turn.id, trace: result.trace, state: result.state, latency_ms: metrics(turn) });
          return result;
        },
      });
      if (token !== generation || !started) { conn.close(); return; }
      connection = conn;
    }
    async function command(message) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Некорректная команда.');
      switch (message.type) {
        case 'start': await start(message.provider || 'openai', message.model); break;
        case 'audio_end': if (started && connection) connection.endAudio?.(); break;
        case 'text': {
          if (!started || !connection) throw new Error('Сначала подключитесь к голосовому сервису.');
          const text = typeof message.text === 'string' ? message.text.trim() : '';
          if (!text || text.length > 8000) throw new Error('Введите от 1 до 8000 символов.');
          if (current?.playback !== null && current?.audioItem) connection.reportPlayback?.({ itemId: current.audioItem, audioEndMs: Math.max(0, monotonic() - current.playback) });
          send({ type: 'interrupt', turnId: current?.id });
          const turn = beginTurn(text);
          turn.end = monotonic();
          turn.userFinal = true;
          turn.transcriptAt = turn.end;
          send({ type: 'transcript', role: 'user', text, final: true, turnId: turn.id });
          suppressProviderInterrupt = true;
          try { connection.sendText(text); } finally { suppressProviderInterrupt = false; }
          break;
        }
        case 'confirm': {
          if (!started || !connection || !lastDecision || typeof message.approved !== 'boolean') throw new Error('Нет действия для подтверждения.');
          const lang = lastDecision.language === 'kk' ? 'kk' : 'ru';
          const text = message.approved ? (lang === 'kk' ? 'Иә, растаймын' : 'Да, подтверждаю') : (lang === 'kk' ? 'Жоқ, бас тартамын' : 'Нет, отменяю');
          // A normal user turn keeps provider and server conversation states consistent.
          await command({ type: 'text', text });
          break;
        }
        case 'stop': stop(); send({ type: 'status', status: 'stopped', provider }); break;
        case 'reset': stop(); session = createSession(data, { id: randomUUID() }); turns.clear(); lastDecision = null; send({ type: 'reset' }); break;
        default: throw new Error('Неизвестная команда.');
      }
    }
    ws.on('message', (raw, binary) => {
      if (binary) return fail('Ожидалось JSON-сообщение.');
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return fail('Некорректный JSON.'); }
      if (message?.type === 'audio') {
        if (!started || !connection) return;
        if (typeof message.data !== 'string' || message.data.length > 64000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data)) return fail('Некорректный аудиокадр.');
        try { connection.sendAudio(message.data); } catch (error) { fail(error); }
      } else if (message?.type === 'playback_started') {
        const turn = turns.get(message.turnId);
        if (turn && turn.playback === null && turn.firstAudio !== null) {
          turn.playback = monotonic();
          if (turn.audioItem) connection?.reportPlayback?.({ itemId: turn.audioItem, audioEndMs: 0 });
          send({ type: 'metrics', turnId: turn.id, latency_ms: metrics(turn) });
        }
      } else {
        commandQueue = commandQueue.then(() => command(message)).catch(error => {
          fail(error);
          if (message?.type === 'start') { stop(); send({ type: 'status', status: 'stopped', provider }); }
        });
      }
    });
    ws.on('error', () => stop());
    ws.on('close', () => { stop(); active.delete(stop); });
  });
  async function close() {
    for (const stop of active) stop();
    for (const ws of wss.clients) ws.close(1001, 'Server shutdown');
    wss.close();
    await new Promise(resolve => server.close(resolve));
  }
  async function refreshModels() {
    await Promise.all(Object.entries(settings).map(async ([name, s]) => {
      const discovered = await modelDiscovery(name, s.apiKey, s.model);
      Object.assign(config.providers[name], discovered, { models: withModelGuidance(discovered.models) });
      if (!discovered.models.some(m => m.id === config.providers[name].model)) config.providers[name].model = discovered.models[0]?.id || s.model;
    }));
  }
  return { server, close, config, refreshModels };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  await app.refreshModels();
  app.server.listen(port, host, () => console.log(`Voice Router: http://${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
}
