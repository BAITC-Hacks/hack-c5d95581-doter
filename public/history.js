'use strict';
const id = new URLSearchParams(location.search).get('id') || '';
const host = document.getElementById('history-turns');
const meta = document.getElementById('history-meta');
const error = document.getElementById('history-error');
const refresh = document.getElementById('refresh-history');
const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
async function load() {
  refresh.disabled = true; error.hidden = true;
  try {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Откройте историю по ссылке из своего разговора.');
    const response = await fetch(`/api/history/${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось загрузить историю.');
    meta.textContent = `${data.provider === 'gemini' ? 'Gemini' : 'OpenAI'} · ${data.model} · ${new Date(data.startedAt).toLocaleString('ru-RU')} · ${data.storage.persistent ? 'Сохранено в PostgreSQL' : 'В памяти до перезапуска'}`;
    host.replaceChildren();
    for (const [index, turn] of (data.turns || []).entries()) {
      const card = node('article', undefined, 'card history-turn');
      card.append(node('h2', `Реплика ${index + 1} · ${turn.turnId}`), node('h3', 'Клиент'), node('p', turn.transcript), node('h3', turn.trace?.spoken_transcript ? 'Voice Router · транскрипт озвучки' : 'Проверенный ответ ядра · озвучка не подтверждена'), node('p', turn.trace?.spoken_transcript || turn.reply, 'answer'));
      const scenarios = (turn.trace?.scenarios || []).map(s => s.scenario_id).join(' → ');
      card.append(node('p', scenarios || 'Маршрут не сохранён', 'history-route'));
      const details = node('details'); details.append(node('summary', 'Решение, действия и контекст'), node('pre', JSON.stringify({ verified_reply: turn.reply, trace: turn.trace, state: turn.state, latency_ms: turn.latency }, null, 2))); card.append(details); host.append(card);
    }
    if (!data.turns?.length) host.append(node('p', 'В этом диалоге пока нет завершённых запросов. Нажмите «Обновить» после ответа ассистента.'));
    if (data.turnsTruncated) host.append(node('p', 'Показана ограниченная часть длинного разговора.'));
  } catch (e) { error.textContent = e.message || 'Хранилище недоступно.'; error.hidden = false; meta.textContent = 'Не удалось открыть диалог.'; }
  finally { refresh.disabled = false; }
}
refresh.addEventListener('click', load);
load();
