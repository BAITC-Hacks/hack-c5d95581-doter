import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { loadData } from '../lib/catalog.mjs';
import { buildInstructions, makeToolSchema } from '../lib/prompts.mjs';
import { connectProvider } from '../lib/providers.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback) => { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1]; };
if (args.includes('--help')) {
  console.log('npm run evaluate -- [--provider openai|gemini] [--limit 10 | --all] [--resume]\nUses real API calls. Default: 10 examples. Outputs artifacts/predictions.json and evaluation-summary.json.');
  process.exit(0);
}
const provider = value('--provider', 'openai');
if (!['openai', 'gemini'].includes(provider)) throw new Error('Unknown provider');
const apiKey = provider === 'openai' ? process.env.OPENAI_API_KEY : (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
if (!apiKey) { console.error(`Set ${provider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY'} in your local .env before running the evaluator.`); process.exit(1); }
const model = provider === 'openai' ? process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1' : process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';
const data = loadData();
const instructions = buildInstructions(data);
const toolSchema = makeToolSchema(data);
const dataset = JSON.parse(await readFile(new URL('../evaluation/dev_utterances.json', import.meta.url), 'utf8'));
const limit = args.includes('--all') ? dataset.utterances.length : Number(value('--limit', '10'));
if (!Number.isInteger(limit) || limit < 1 || limit > dataset.utterances.length) throw new Error(`--limit must be 1..${dataset.utterances.length}`);
const selected = dataset.utterances.slice(0, limit);
const runHash = createHash('sha256').update(JSON.stringify({ provider, model, instructions, toolSchema, dataset })).digest('hex');
const directory = new URL('../artifacts/', import.meta.url);
await mkdir(directory, { recursive: true });
const predictionsFile = new URL('predictions.json', directory);
const summaryFile = new URL('evaluation-summary.json', directory);
let predictions = {};
let rows = [];
if (args.includes('--resume')) {
  try {
    const previous = JSON.parse(await readFile(summaryFile, 'utf8'));
    if (previous.runHash !== runHash) throw new Error('Resume inputs/model/prompt differ; run without --resume.');
    predictions = JSON.parse(await readFile(predictionsFile, 'utf8'));
    rows = previous.rows || [];
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const validIds = new Set([...data.scenarios.scenarios.map(s => s.scenario_id), ...data.scenarios.system_intents.map(s => s.id)]);
function scores() {
  const done = selected.filter(item => Object.hasOwn(predictions, item.id));
  const primary = done.filter(item => predictions[item.id][0] === item.expected[0]).length;
  const full = done.filter(item => { const a = new Set(predictions[item.id]); return a.size === new Set(item.expected).size && item.expected.every(id => a.has(id)); }).length;
  const multi = done.filter(item => item.expected.length > 1);
  const expectedIntents = multi.reduce((n, item) => n + item.expected.length, 0);
  const found = multi.reduce((n, item) => n + item.expected.filter(id => predictions[item.id].includes(id)).length, 0);
  return { evaluated: done.length, requested: selected.length, dataset: dataset.utterances.length, primaryCorrect: primary, primaryAccuracy: done.length ? primary / done.length : null, fullMatch: done.length ? full / done.length : null, multiIntentRecall: expectedIntents ? found / expectedIntents : null };
}
async function save() {
  await writeFile(predictionsFile, JSON.stringify(predictions, null, 2) + '\n');
  await writeFile(summaryFile, JSON.stringify({ runHash, provider, model, createdAt: new Date().toISOString(), scores: scores(), rows }, null, 2) + '\n');
}
async function classify(text) {
  let connection;
  let settle;
  let rejectTurn;
  const answer = new Promise((resolve, reject) => { settle = resolve; rejectTurn = reject; });
  // Attach a handler immediately so a connection error cannot create an unhandled rejection.
  answer.catch(() => {});
  const timer = setTimeout(() => rejectTurn(new Error('Routing timeout after 45 seconds')), 45_000);
  try {
    connection = await connectProvider({ provider, apiKey, model, instructions, toolSchema,
      onEvent: event => { if (event.type === 'error') rejectTurn(new Error(event.message)); },
      onRoute: async decision => {
        const ids = decision?.scenarios?.map(s => s.scenario_id);
        if (!Array.isArray(ids) || !ids.length || ids.some(id => !validIds.has(id))) {
          rejectTurn(new Error('Model returned invalid scenario identifiers'));
        } else settle({ ids: [...new Set(ids)], language: decision.language });
        return { reply: '', trace: {}, state: {} };
      },
    });
    connection.sendText(text);
    return await answer;
  } finally { clearTimeout(timer); connection?.close(); }
}
for (const item of selected) {
  if (Object.hasOwn(predictions, item.id)) continue;
  const start = performance.now();
  try {
    const result = await classify(item.text); // Expected labels are NEVER sent to the model.
    predictions[item.id] = result.ids;
    rows.push({ id: item.id, predicted: result.ids, expected: item.expected, language: item.lang, type: item.type, elapsed_ms: Math.round(performance.now() - start) });
    console.log(`${item.id}: ${result.ids.join(', ')} (${Math.round(performance.now() - start)} ms)`);
    await save();
  } catch (error) {
    await save();
    console.error(`Stopped at ${item.id}: ${String(error.message).split(apiKey).join('[redacted]')}. Completed predictions saved; use --resume to continue.`);
    process.exitCode = 1;
    break;
  }
}
await save();
console.log(JSON.stringify(scores(), null, 2));
