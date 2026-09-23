import { readFileSync } from 'node:fs';

const names = { scenarios: 'scenarios.json', slots: 'slots.json', actions: 'actions.json', knowledge: 'knowledge_base.json', backend: 'mock_backend.json' };
export function loadData(directory = new URL('../data/', import.meta.url)) {
  return Object.fromEntries(Object.entries(names).map(([key, file]) => [key, JSON.parse(readFileSync(new URL(file, directory), 'utf8').replace(/^\uFEFF/, ''))]));
}
export function publicCatalog(data) {
  return [
    ...data.scenarios.scenarios.map(s => ({ id: s.scenario_id, name: s.name, description: s.description })),
    ...data.scenarios.system_intents.map(s => ({ id: s.id, name: s.name || s.id, description: s.description })),
  ];
}
