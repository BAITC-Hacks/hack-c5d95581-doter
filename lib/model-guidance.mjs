// Pricing and positioning checked against official provider documentation on 2026-09-23.
// Exact IDs only: a new model name must not inherit an unverified price or quality claim.
const checkedAt = '2026-09-23';
const openaiPage = id => `https://developers.openai.com/api/docs/models/${id}`;
const audio = (input, output, cachedInput) => ({ unit: 'USD / 1M audio tokens', input, output, ...(cachedInput === undefined ? {} : { cachedInput }) });
const definitions = {
  'gpt-realtime-2.1': {
    tag: 'Приоритет качества', summary: 'Для сложных запросов и работы с инструментами.',
    detail: 'Рекомендация внутри линейки OpenAI. Аудио: $32 вход / $64 выход за 1 млн токенов. Это позиционирование производителя, а не измеренное превосходство над Gemini.',
    sourceUrl: openaiPage('gpt-realtime-2.1'), audioPrice: audio(32, 64, 0.40),
  },
  'gpt-realtime-2.1-mini': {
    tag: 'Экономнее в OpenAI', summary: 'Более быстрый и недорогой вариант голосовой модели.',
    detail: 'Аудио: $10 вход / $20 выход за 1 млн токенов против $32 / $64 у полной 2.1. Сложные инструкции и инструменты требуют проверки на своих сценариях.',
    sourceUrl: openaiPage('gpt-realtime-2.1-mini'), audioPrice: audio(10, 20, 0.30),
  },
  'gemini-3.8-live': {
    tag: 'Ниже аудиотариф', summary: 'Диалог с малой задержкой; аудиотариф ниже GPT Realtime 2.1.',
    detail: 'Аудио: $3 вход / $12 выход за 1 млн токенов. Итоговая стоимость зависит от истории, времени прослушивания и транскрипции. Сравнительный тест качества с OpenAI не проводился.',
    sourceUrl: 'https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live', audioPrice: audio(3, 12),
  },
};
for (const id of ['gpt-realtime-2', 'gpt-realtime-1.5']) definitions[id] = {
  tag: 'Предыдущее поколение', summary: 'Ранняя полноразмерная модель Realtime.',
  detail: 'Аудио: $32 вход / $64 выход за 1 млн токенов. Совпадение аудиотарифа не означает одинаковое качество или стоимость всей сессии.',
  sourceUrl: openaiPage(id), audioPrice: audio(32, 64, 0.40),
};
for (const id of ['gpt-realtime', 'gpt-realtime-2025-08-28']) definitions[id] = {
  tag: 'Старая версия', summary: 'Первое поколение Realtime; доступно для сравнения.',
  detail: 'Семейство устарело; отключение запланировано на 20.01.2027. Аудиотариф семейства: $32 вход / $64 выход за 1 млн токенов.',
  sourceUrl: openaiPage('gpt-realtime'), audioPrice: audio(32, 64, 0.40),
};
for (const id of ['gpt-realtime-mini', 'gpt-realtime-mini-2025-12-15']) definitions[id] = {
  tag: 'Экономичная · прежняя', summary: 'Экономичная модель предыдущей линейки.',
  detail: 'Числовой аудиотариф этой версии не подтверждён текущей карточкой. Отключение семейства запланировано на 20.01.2027; тариф новой 2.1-mini к нему не применяется.',
  sourceUrl: openaiPage('gpt-realtime-mini'),
};
export function modelGuidance(id) {
  return structuredClone({ checkedAt, ...(definitions[id] || {
    tag: 'Без оценки', summary: 'Модель из каталога; профиль ещё не проверен.',
    detail: 'Тариф и качество для этого точного идентификатора не подтверждены. Название само по себе не определяет стоимость или надёжность.',
  }) });
}
export function providerGuidance(provider) {
  return provider === 'gemini' ? {
    tag: 'Ниже аудиотариф', summary: 'Gemini 3.8 Live: ниже ставки аудио, чем у полной GPT Realtime 2.1.',
    detail: 'Аудио: $3 вход / $12 выход за 1 млн токенов. Это сравнение ставок, не фиксированная цена минуты разговора. Качество маршрутизации относительно OpenAI не сравнивалось.',
    sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing', checkedAt,
  } : {
    tag: 'Качество или экономия', summary: 'Полная модель дороже; mini снижает расходы внутри OpenAI.',
    detail: 'Полная Realtime 2.1 рекомендована для сложных инструкций и инструментов; 2.1-mini — более экономичный вариант. Профиль зависит от выбранной модели.',
    sourceUrl: 'https://developers.openai.com/api/docs/guides/voice-latency-cost', checkedAt,
  };
}
export const withModelGuidance = models => models.map(model => ({ ...model, guidance: modelGuidance(model.id) }));
