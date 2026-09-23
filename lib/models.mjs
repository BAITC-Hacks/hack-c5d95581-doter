export async function discoverModels(provider, apiKey, preferred, { fetchImpl = fetch } = {}) {
  const fallback = [{ id: preferred, label: preferred }];
  if (!apiKey) return { models: fallback, verified: false, catalogError: null };
  const url = provider === 'openai' ? 'https://api.openai.com/v1/models' : 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000';
  try {
    const response = await fetchImpl(url, { headers: provider === 'openai' ? { Authorization: `Bearer ${apiKey}` } : { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) return { models: fallback, verified: false, catalogError: `Каталог моделей недоступен (HTTP ${response.status}).` };
    const body = await response.json();
    if (provider === 'gemini') {
      const found = (body.models || []).some(m => m.name === `models/${preferred}`);
      return { models: fallback, verified: found, catalogError: found ? null : 'Выбранная Gemini Live модель не найдена в каталоге этого ключа.' };
    }
    const ids = (body.data || []).map(m => m.id).filter(id => typeof id === 'string' && /realtime/i.test(id) && !/(transcri|translate|whisper)/i.test(id));
    const models = [...new Set(ids)].sort((a, b) => a === preferred ? -1 : b === preferred ? 1 : a.localeCompare(b)).map(id => ({ id, label: id }));
    return { models: models.length ? models : fallback, verified: models.length > 0, catalogError: models.length ? null : 'Realtime модели не найдены в каталоге этого ключа.' };
  } catch {
    return { models: fallback, verified: false, catalogError: 'Не удалось получить каталог моделей. Можно проверить выбранную модель подключением.' };
  }
}
