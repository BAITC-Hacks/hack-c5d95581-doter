import { discoverModels } from '../lib/models.mjs';
const results = await Promise.all([
  discoverModels('openai', process.env.OPENAI_API_KEY, process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1'),
  discoverModels('gemini', process.env.GEMINI_API_KEY, process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live'),
]);
console.log(JSON.stringify({ openai: results[0], gemini: results[1] }, null, 2));
