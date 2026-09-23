import { pathToFileURL } from 'node:url';
import { connectProvider } from '../lib/providers.mjs';
import { loadData } from '../lib/catalog.mjs';
import { buildInstructions, makeToolSchema } from '../lib/prompts.mjs';
import { createSession, processTurn } from '../lib/engine.mjs';
import WebSocket from 'ws';

// For synthetic diagnostics only: never capture credentials, request URLs, or audio payloads.
export function createGeminiWireDiagnostic({ started = performance.now(), onTurnComplete = () => {} } = {}) {
  const summary = { messageShapes: [], timeline: [], tools: [], usage: [],
    audioInputChunks: 0, audioInputBytes: 0, generatedAudioChunks: 0,
    inputTranscript: '', outputTranscript: '' };
  const shapes = new Set();
  const elapsed = () => Math.round(performance.now() - started);
  function socketFactory(url, options) {
    const socket = new WebSocket(url, options);
    const send = socket.send.bind(socket);
    socket.send = raw => {
      const payload = JSON.parse(raw);
      const input = payload.realtimeInput;
      if (input?.audio) {
        summary.firstInputAudioMs ??= elapsed();
        summary.lastInputAudioMs = elapsed();
        summary.audioInputChunks++;
        summary.audioInputBytes += Buffer.from(input.audio.data, 'base64').length;
        summary.inputMimeType = input.audio.mimeType;
      } else {
        summary.timeline.push({ direction: 'out', keys: Object.keys(payload),
          realtimeInput: input && Object.keys(input), elapsedMs: elapsed() });
      }
      return send(raw);
    };
    socket.on('message', raw => {
      const event = JSON.parse(raw.toString());
      const content = event.serverContent;
      const shape = JSON.stringify({ root: Object.keys(event), content: content && Object.keys(content),
        parts: content?.modelTurn?.parts?.map(part => Object.keys(part)) });
      if (!shapes.has(shape)) { shapes.add(shape); summary.messageShapes.push(JSON.parse(shape)); }
      if (event.toolCall || content?.turnComplete || content?.generationComplete || content?.waitingForInput ||
          content?.speechState || content?.interactionStatus || content?.interrupted) {
        summary.timeline.push({ direction: 'in', keys: Object.keys(event), content: content && Object.keys(content),
          waitingForInput: content?.waitingForInput, speechState: content?.speechState,
          interactionStatus: content?.interactionStatus, interrupted: content?.interrupted, elapsedMs: elapsed() });
      }
      for (const call of event.toolCall?.functionCalls || []) summary.tools.push({ id: call.id, name: call.name, args: call.args });
      for (const part of content?.modelTurn?.parts || []) {
        if (part.inlineData?.mimeType?.startsWith('audio/pcm')) {
          summary.firstOutputAudioMs ??= elapsed(); summary.generatedAudioChunks++;
        }
        if (part.functionCall) summary.tools.push({ inline: true, name: part.functionCall.name, args: part.functionCall.args });
        if (part.text && !part.thought) summary.modelText = (summary.modelText || '') + part.text;
      }
      if (content?.inputTranscription?.text) summary.inputTranscript += content.inputTranscription.text;
      if (content?.interimInputTranscription?.text) summary.interimInputTranscript = content.interimInputTranscription.text;
      if (content?.outputTranscription?.text) summary.outputTranscript += content.outputTranscription.text;
      if (event.usageMetadata) summary.usage.push(event.usageMetadata);
      if (content?.turnComplete) setImmediate(onTurnComplete);
    });
    return socket;
  }
  return { summary, socketFactory };
}

async function diagnoseText() {
  const data = loadData();
  const session = createSession(data);
  const model = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';
  const summary = { model, releasedAudioChunks: 0, result: null, errors: [] };
  let connection, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const timer = setTimeout(() => { summary.errors.push('Diagnostic timeout'); finish(); }, 45000);
  const start = performance.now();
  const wire = createGeminiWireDiagnostic({ started: start, onTurnComplete: () => { if (summary.releasedAudioChunks) finish(); } });
  try {
    connection = await connectProvider({ provider: 'gemini', apiKey: process.env.GEMINI_API_KEY,
      model, instructions: buildInstructions(data), toolSchema: makeToolSchema(data), socketFactory: wire.socketFactory,
      onEvent(event) {
        if (event.type === 'audio') summary.releasedAudioChunks++;
        if (event.type === 'error') { summary.errors.push(event.message); finish(); }
      },
      onRoute(decision) {
        const result = processTurn(session, decision, { turnId: 'diagnostic-1', transcript: decision.transcript });
        summary.result = { scenarios: result.trace.scenarios.map(s => s.scenario_id), status: result.trace.status, reply: result.reply };
        return result;
      },
    });
    connection.sendText('Здравствуйте, хочу узнать стоимость ОГПО на машину в Алматы.');
    await done;
  } catch (error) {
    const key = process.env.GEMINI_API_KEY;
    summary.errors.push(String(error.message).split(key || '__missing_key__').join('[redacted]')
      .replace(/([?&](?:key|access_token)=)[^\s&"']+/gi, '$1[redacted]'));
  } finally {
    clearTimeout(timer); connection?.close(); summary.elapsedMs = Math.round(performance.now() - start);
    console.log(JSON.stringify({ ...summary, wire: wire.summary }));
    if (summary.errors.length || !summary.result || !summary.releasedAudioChunks) process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await diagnoseText();
