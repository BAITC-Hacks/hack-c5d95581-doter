/** Paid, bounded native-audio smoke using synthetic speech only (no physical microphone).
 * node --env-file=.env tools/smoke-audio.mjs openai
 * node --env-file=.env tools/smoke-audio.mjs gemini --reuse
 * First command synthesizes one short Russian sample; --reuse reads that exact PCM.
 * Times use the local monotonic clock. First output is received PCM, not audible playback.
 */
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { connectProvider } from '../lib/providers.mjs';
import { loadData } from '../lib/catalog.mjs';
import { buildInstructions, makeToolSchema } from '../lib/prompts.mjs';
import { createSession, processTurn } from '../lib/engine.mjs';
import { createGeminiWireDiagnostic } from './diagnose-gemini.mjs';

const LABEL = 'synthetic-ru-almaty-offices-v1';
const TEXT = 'Здравствуйте, где находятся офисы в Алматы?';
const SOURCE_RATE = 24000;
const MAX_SAMPLE_BYTES = SOURCE_RATE * 2 * 15;
const FRAME_MS = 40;
const started = performance.now();
const deadline = started + 45000;
const [provider = 'openai', ...flags] = process.argv.slice(2);
const silenceTailMs = flags.includes('--silence-tail') ? 800 : 0;
const wire = provider === 'gemini' && flags.includes('--wire') ? createGeminiWireDiagnostic({ started }) : null;
const cache = new URL(`../artifacts/${LABEL}.pcm`, import.meta.url);
const metadataFile = new URL(`../artifacts/${LABEL}.json`, import.meta.url);
const keys = { openai: process.env.OPENAI_API_KEY, gemini: process.env.GEMINI_API_KEY };
const models = { openai: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1',
  gemini: process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live' };
const data = loadData();
const instructions = buildInstructions(data), toolSchema = makeToolSchema(data);
let stage = 'arguments';
let partialEvidence = () => ({});
const ms = value => value === undefined || value === null ? null : Math.round(value);
const now = () => performance.now();
const hash = value => createHash('sha256').update(value).digest('hex');
const normalized = value => String(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function safeError(error) {
  let text = String(error?.message || error);
  for (const key of Object.values(keys)) if (key) {
    text = text.split(key).join('[REDACTED]').split(encodeURIComponent(key)).join('[REDACTED]');
  }
  return text.replace(/(?:https?|wss?):\/\/\S+/gi, '[URL REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 500);
}

async function phase(selected, hooks, sendInput) {
  const completion = Promise.withResolvers();
  completion.promise.catch(() => {});
  let connection, stopped = false;
  const fail = error => { completion.reject(error); connection?.close(); };
  const remaining = deadline - now();
  if (remaining <= 0) throw new Error('45-second total smoke timeout');
  const timer = setTimeout(() => fail(new Error('45-second total smoke timeout')), remaining);
  try {
    const pending = connectProvider({ provider: selected, apiKey: keys[selected], model: models[selected],
      instructions, toolSchema, connectTimeoutMs: Math.min(20000, remaining),
      onRoute: hooks.onRoute,
      ...(selected === 'gemini' && wire ? { socketFactory: wire.socketFactory } : {}),
      onEvent(event) {
        if (stopped) return;
        try {
          if (event.type === 'error') throw new Error(event.message);
          hooks.onEvent(event, completion.resolve);
        } catch (error) { fail(error); }
      },
    }).then(value => { connection = value; if (stopped) value.close(); return value; });
    connection = await Promise.race([pending, completion.promise]);
    await Promise.race([sendInput(connection, () => stopped), completion.promise]);
    return await completion.promise;
  } finally {
    stopped = true;
    clearTimeout(timer);
    connection?.close();
  }
}

async function synthesize() {
  stage = 'synthetic-speech-generation';
  const chunks = [];
  let bytes = 0, transcript = '', speechStarted;
  const metadata = await phase('openai', {
    onRoute: async () => { throw new Error('Synthetic speak unexpectedly invoked routing'); },
    onEvent(event, complete) {
      if (event.type === 'audio') {
        if (event.sampleRate !== SOURCE_RATE) throw new Error('Unexpected synthesis sample rate');
        const chunk = Buffer.from(event.data, 'base64');
        bytes += chunk.length;
        if (bytes >= MAX_SAMPLE_BYTES) throw new Error('Synthetic sample reached the 15-second limit');
        chunks.push(chunk);
      }
      if (event.type === 'transcript' && event.role === 'assistant' && event.final) transcript = event.text;
      if (event.type === 'audio_done') {
        if (!bytes || bytes % 2) throw new Error('Synthesis returned no complete PCM16 audio');
        if (normalized(transcript) !== normalized(TEXT)) throw new Error('Synthetic output transcript did not match the requested sample');
        complete({ label: LABEL, source: 'OpenAI native speak; synthetic, no physical microphone',
          provider: 'openai', model: models.openai, sampleRate: SOURCE_RATE, format: 'mono PCM16LE',
          text: TEXT, transcript, bytes, durationMs: ms(bytes / (SOURCE_RATE * 2) * 1000),
          synthesisRequestToAudioDoneMs: ms(now() - speechStarted) });
      }
    },
  }, async connection => { speechStarted = now(); connection.speak(TEXT); });
  const pcm = Buffer.concat(chunks);
  metadata.sha256 = hash(pcm);
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await writeFile(cache, pcm);
  await writeFile(metadataFile, JSON.stringify(metadata, null, 2) + '\n');
  return { pcm, metadata };
}

async function reuseSample() {
  stage = 'read-synthetic-cache';
  const [pcm, raw] = await Promise.all([readFile(cache), readFile(metadataFile, 'utf8')]);
  const metadata = JSON.parse(raw);
  if (metadata.label !== LABEL || metadata.text !== TEXT || metadata.sampleRate !== SOURCE_RATE ||
      metadata.sha256 !== hash(pcm) || metadata.bytes !== pcm.length || !pcm.length ||
      pcm.length % 2 || pcm.length >= MAX_SAMPLE_BYTES) throw new Error('Synthetic PCM cache validation failed');
  return { pcm, metadata };
}

// Windowed sinc low-pass conversion keeps the same synthetic sample at Gemini's 16 kHz input rate.
function resample24To16(pcm) {
  const samples = pcm.length / 2, count = Math.floor(samples * 2 / 3), output = Buffer.alloc(count * 2);
  const radius = 24, cutoff = 0.3;
  for (let i = 0; i < count; i++) {
    const position = i * 1.5, center = Math.floor(position);
    let sum = 0, weightSum = 0;
    for (let index = center - radius + 1; index <= center + radius; index++) {
      if (index < 0 || index >= samples) continue;
      const distance = index - position;
      if (Math.abs(distance) >= radius) continue;
      const angle = 2 * Math.PI * cutoff * distance;
      const weight = (angle === 0 ? 2 * cutoff : 2 * cutoff * Math.sin(angle) / angle) *
        (0.5 + 0.5 * Math.cos(Math.PI * distance / radius));
      sum += pcm.readInt16LE(index * 2) * weight;
      weightSum += weight;
    }
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / weightSum))), i * 2);
  }
  return output;
}

async function routeAudio(source) {
  stage = `${provider}-native-audio-input`;
  const sampleRate = provider === 'openai' ? SOURCE_RATE : 16000;
  const pcm = sampleRate === SOURCE_RATE ? source.pcm : resample24To16(source.pcm);
  const frameBytes = sampleRate * 2 * FRAME_MS / 1000;
  const session = createSession(data);
  const t = {};
  let decision, result, inputTranscript = '', inputTranscriptFinal = false, outputTranscript = '', audioBytes = 0, routeCalls = 0;
  const expected = data.scenarios.scenarios.find(item => item.slug === 'offices')?.scenario_id;
  const eventCounts = {};
  partialEvidence = () => ({ ready: t.ready !== undefined, inputSent: t.inputEnd !== undefined,
    inputTranscript, inputTranscriptFinal, routeCalls, decisionTranscript: decision?.transcript,
    scenarios: result?.trace.scenarios, status: result?.trace.status, validatedReply: result?.reply,
    outputTranscript, audioBytes, eventCounts, ...(wire ? { wire: wire.summary } : {}) });
  function evidence() {
    if (routeCalls !== 1 || !result || !audioBytes || !inputTranscript || !outputTranscript) {
      throw new Error('Missing single routed turn, transcripts, grounded reply, or output audio');
    }
    if (result.trace.scenarios[0]?.scenario_id !== expected || result.trace.status !== 'completed' ||
        result.trace.validation_errors.length) throw new Error('Office query did not complete through the expected grounded scenario');
    return { test: LABEL, inputKind: 'synthetic-native-speech; no physical microphone or acoustic validation',
      provider, model: models[provider], source: source.metadata,
      input: { sampleRate, bytes: pcm.length, durationMs: ms(pcm.length / (sampleRate * 2) * 1000), frameMs: FRAME_MS,
        resampling: sampleRate === SOURCE_RATE ? 'none' : '24kHz to 16kHz windowed-sinc', silenceTailMs },
      inputTranscript, inputTranscriptFinal, decisionTranscript: decision.transcript,
      ...(wire ? { wire: wire.summary } : {}),
      routes: result.trace.scenarios, routeCalls, status: result.trace.status, actions: result.trace.actions,
      validatedReply: result.reply, outputTranscript,
      outputTranscriptMatchesReply: normalized(outputTranscript) === normalized(result.reply), audioBytes,
      timingMs: { connectToReady: ms(t.ready - t.connect), inputFirstFrameToEndAudio: ms(t.inputEnd - t.inputStart),
        inputEndToUserTranscriptFinal: ms(t.transcript === undefined ? null : t.transcript - t.inputEnd),
        inputEndToRouteCallback: ms(t.route - t.inputEnd), engineProcessing: ms(t.engineEnd - t.route),
        inputEndToFirstOutputAudio: ms(t.firstAudio - t.inputEnd), engineEndToFirstOutputAudio: ms(t.firstAudio - t.engineEnd),
        inputEndToOutputComplete: ms(t.outputDone - t.inputEnd), total: ms(now() - started) },
      timingBoundary: 'Local monotonic receive/send times. inputEnd is the call to endAudio after realtime-paced PCM; outputComplete is OpenAI audio_done or Gemini final assistant transcript at turnComplete. No browser playback timing.' };
  }
  t.connect = now();
  return phase(provider, {
    onRoute: async routed => {
      routeCalls++;
      if (routeCalls > 1) throw new Error('More than one route callback for one synthetic sample');
      t.route = now(); decision = routed;
      result = processTurn(session, routed, { turnId: LABEL, transcript: routed.transcript });
      t.engineEnd = now();
      return result;
    },
    onEvent(event, complete) {
      eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
      if (event.type === 'status' && event.status === 'ready') t.ready = now();
      if (event.type === 'transcript' && event.role === 'user') {
        inputTranscript = event.text; inputTranscriptFinal = event.final;
        if (event.final) t.transcript = now();
      }
      if (event.type === 'audio') {
        if (!result) throw new Error('Output audio arrived before grounded engine reply');
        t.firstAudio ??= now(); audioBytes += Buffer.from(event.data, 'base64').length;
      }
      if (event.type === 'transcript' && event.role === 'assistant') outputTranscript = event.text;
      if (event.type === 'audio_done' || (provider === 'gemini' && event.type === 'transcript' && event.role === 'assistant' && event.final)) {
        t.outputDone = now(); complete(evidence());
      }
    },
  }, async (connection, stopped) => {
    t.inputStart = now();
    for (let offset = 0; offset < pcm.length; offset += frameBytes) {
      if (stopped()) return;
      connection.sendAudio(pcm.subarray(offset, offset + frameBytes).toString('base64'));
      await sleep(Math.max(0, t.inputStart + Math.min(offset + frameBytes, pcm.length) / (sampleRate * 2) * 1000 - now()));
    }
    const tailStart = now();
    for (let elapsed = 0; elapsed < silenceTailMs; elapsed += FRAME_MS) {
      if (stopped()) return;
      connection.sendAudio(Buffer.alloc(frameBytes).toString('base64'));
      await sleep(Math.max(0, tailStart + elapsed + FRAME_MS - now()));
    }
    t.inputEnd = now(); connection.endAudio();
  });
}

try {
  if (!['openai', 'gemini'].includes(provider) || flags.some(flag => !['--reuse', '--wire', '--silence-tail'].includes(flag))) {
    throw new Error('Usage: node --env-file=.env tools/smoke-audio.mjs [openai|gemini] [--reuse] [--wire] [--silence-tail]');
  }
  if (!keys[provider]) throw new Error('Selected provider API key is missing');
  const sample = flags.includes('--reuse') ? await reuseSample() : await synthesize();
  console.log(JSON.stringify(await routeAudio(sample)));
} catch (error) {
  console.error(JSON.stringify({ test: LABEL, provider, model: models[provider], stage,
    error: safeError(error), partial: partialEvidence(), elapsedMs: ms(now() - started) }));
  process.exitCode = 1;
}
