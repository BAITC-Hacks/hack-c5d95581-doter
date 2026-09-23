import { connectProvider } from '../lib/providers.mjs';
import { loadData } from '../lib/catalog.mjs';
import { buildInstructions, makeToolSchema } from '../lib/prompts.mjs';
import { createSession, processTurn } from '../lib/engine.mjs';
import { performance } from 'node:perf_hooks';
const provider = process.argv[2] || 'openai';
const key = provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY;
const model = provider === 'openai' ? process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1' : process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';
const data = loadData();
const session = createSession(data);
let connection, output, resolveResult, rejectResult;
const start = performance.now();
const done = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
done.catch(() => {});
const timeout = setTimeout(() => rejectResult(new Error('No routed audio within 45 seconds')), 45000);
try {
  connection = await connectProvider({ provider, apiKey:key, model, instructions:buildInstructions(data), toolSchema:makeToolSchema(data),
    onEvent(event) {
      if (event.type === 'error') rejectResult(new Error(event.message));
      if (event.type === 'audio' && output) resolveResult({provider,model,...output,audioBytes:Buffer.from(event.data,'base64').length,elapsedMs:Math.round(performance.now()-start)});
    },
    onRoute: async decision => {
      const result = processTurn(session,decision,{turnId:'smoke-1',transcript:decision.transcript});
      output = {scenarios:result.trace.scenarios.map(s=>s.scenario_id),status:result.trace.status,reply:result.reply};
      return result;
    },
  });
  connection.sendText('Здравствуйте, хочу узнать стоимость ОГПО на машину в Алматы.');
  console.log(JSON.stringify(await done));
} catch(error) { console.error(JSON.stringify({provider,model,error:String(error.message).split(key||'__missing_key__').join('[redacted]')})); process.exitCode=1; }
finally {clearTimeout(timeout);connection?.close();}
