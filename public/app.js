'use strict';

const byId = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'provider', 'model', 'provider-tag', 'provider-summary', 'provider-detail', 'provider-source',
  'model-tag', 'model-summary', 'model-detail', 'model-source', 'model-guide-list', 'provider-availability', 'provider-model', 'start', 'start-text', 'mute',
  'stop', 'reset', 'send', 'text-form', 'text-input', 'text-hint', 'notice',
  'notice-text', 'dismiss-notice', 'connection-badge', 'connection-label',
  'voice-stage', 'voice-title', 'voice-description', 'session-footnote',
  'transcript', 'conversation-empty', 'message-count', 'as-of-date', 'catalog-summary',
  'route-empty', 'route-results', 'route-status', 'trace-language', 'trace-turn',
  'scenarios', 'alternatives', 'slots', 'slot-count', 'active-scenario',
  'queued-scenarios', 'server-state', 'actions', 'action-count', 'confirmation',
  'confirmation-description', 'confirmation-data', 'confirmation-details',
  'approve', 'reject', 'metric-first', 'metric-route', 'metric-backend', 'metric-transcript'
].map((id) => [id, byId(id)]));

const AudioContextClass = window.AudioContext || window.webkitAudioContext;
let config = null;
const selectedModels = new Map();
let catalog = new Map();
let socket = null;
let generation = 0;
let phase = 'stopped';
let wantsMicrophone = false;
let muted = false;
let microphonePending = false;
let microphoneStream = null;
let captureContext = null;
let captureSource = null;
let captureWorklet = null;
let captureGain = null;
let inputSampleRate = 24000;
let playbackContext = null;
let nextPlaybackTime = 0;
let currentTurn = null;
let awaitingConfirmation = false;
let level = 0;
const playbackSources = new Set();
const playbackTimers = new Set();
const playbackPendingTurns = new Set();
const playbackReportedTurns = new Set();
const blockedTurns = new Set();
const messages = new Map();
const metrics = new Map();
const slotLabels = {
  policy_number: 'Номер полиса', policy_id: 'Полис', claim_id: 'Страховой случай',
  claim_number: 'Номер обращения', client_id: 'Клиент', customer_id: 'Клиент',
  phone: 'Телефон', phone_number: 'Телефон', full_name: 'ФИО', name: 'Имя',
  iin: 'ИИН', email: 'Email', date: 'Дата', event_date: 'Дата события',
  incident_date: 'Дата происшествия', city: 'Город', address: 'Адрес',
  insurance_type: 'Вид страхования', product: 'Продукт', amount: 'Сумма',
  vehicle_number: 'Госномер', vehicle_plate: 'Госномер', language: 'Язык'
};
const statusLabels = {
  active: 'В работе', ready: 'Готово', completed: 'Завершено', complete: 'Завершено',
  success: 'Выполнено', ok: 'Выполнено', pending: 'В ожидании', routing: 'Выбор маршрута',
  awaiting_confirmation: 'Подтверждение', needs_confirmation: 'Подтверждение',
  awaiting_slot: 'Уточнение', awaiting_slots: 'Уточнение', needs_clarification: 'Уточнение',
  collecting_slots: 'Уточнение', collecting: 'Уточнение', clarification: 'Уточнение',
  error: 'Ошибка', failed: 'Ошибка', cancelled: 'Отменено', rejected: 'Отменено',
  idle: 'Ожидание', no_action: 'Без действия'
};

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined && content !== null) node.textContent = String(content);
  return node;
}

function stringify(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function showNotice(message, isError = false) {
  ui.notice.hidden = false;
  ui.notice.classList.toggle('error', isError);
  ui['notice-text'].textContent = message;
}

function hideNotice() {
  ui.notice.hidden = true;
}

function availableProvider() {
  return config?.providers?.[ui.provider.value]?.configured === true && Boolean(ui.model.value);
}

function modelOptions(provider) {
  const configured = Array.isArray(provider?.models) ? provider.models
    : provider?.model ? [{ id: provider.model, label: provider.model }] : [];
  const models = new Map();
  for (const model of configured) {
    if (typeof model?.id !== 'string' || !model.id.trim()) continue;
    models.set(model.id, {
      ...model,
      label: typeof model.label === 'string' && model.label.trim() ? model.label : model.id
    });
  }
  return models;
}

function guidanceText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function renderGuidance(prefix, guidance, fallback) {
  const tag = guidanceText(guidance?.tag);
  ui[`${prefix}-tag`].textContent = tag;
  ui[`${prefix}-tag`].hidden = !tag;
  ui[`${prefix}-summary`].textContent = guidanceText(guidance?.summary) || fallback;
  ui[`${prefix}-detail`].textContent = guidanceText(guidance?.detail);
  const source = ui[`${prefix}-source`];
  source.hidden = true;
  source.removeAttribute('href');
  try {
    const url = new URL(guidance?.sourceUrl);
    if (url.protocol === 'https:' && !url.username && !url.password) {
      source.href = url.href;
      source.hidden = false;
    }
  } catch { /* Guidance may have no published source. */ }
}

function renderModelGuidance() {
  const provider = config?.providers?.[ui.provider.value];
  const models = modelOptions(provider);
  const selected = models.get(ui.model.value);
  renderGuidance('provider', provider?.guidance, 'Голосовой провайдер для текущей сессии.');
  renderGuidance('model', selected?.guidance, 'Для этой модели пока нет сравнительной подсказки.');
  ui['model-detail'].hidden = !ui['model-detail'].textContent;
  ui['provider-detail'].hidden = !ui['provider-detail'].textContent;
  ui['provider-model'].textContent = ui.model.value || 'Модель не указана';
  ui['model-guide-list'].replaceChildren();
  for (const model of models.values()) {
    const current = model.id === ui.model.value;
    const row = element('li', `model-guide-item${current ? ' selected' : ''}`);
    const heading = element('div', 'model-guide-heading');
    const title = element('strong', '', model.label);
    title.setAttribute('translate', 'no');
    if (current) title.append(element('span', 'visually-hidden', ' — выбрана'));
    heading.append(title);
    const tag = guidanceText(model.guidance?.tag);
    if (tag) heading.append(element('span', 'guide-tag', tag));
    row.append(heading, element('p', '', guidanceText(model.guidance?.summary) || 'Сравнительная подсказка пока не опубликована.'));
    ui['model-guide-list'].append(row);
  }
}

function renderProvider() {
  const providerName = ui.provider.value;
  const provider = config?.providers?.[providerName];
  const models = modelOptions(provider);
  const remembered = selectedModels.get(providerName);
  const selected = models.has(remembered) ? remembered
    : models.has(provider?.model) ? provider.model : models.keys().next().value || '';
  ui.model.replaceChildren();
  for (const [id, model] of models) {
    const tag = guidanceText(model.guidance?.tag);
    const option = element('option', '', `${model.label}${tag ? ` · ${tag}` : ''}`);
    option.value = id;
    ui.model.append(option);
  }
  if (!models.size) {
    const option = element('option', '', 'Нет моделей в конфигурации');
    option.value = '';
    ui.model.append(option);
  }
  ui.model.value = selected;
  selectedModels.set(providerName, selected);
  renderModelGuidance();
  ui['provider-availability'].textContent = provider?.configured
    ? 'Ключ настроен на сервере' : 'API-ключ не настроен';
  ui['provider-availability'].className = `availability ${provider?.configured ? 'available' : 'unavailable'}`;
  if (!provider?.configured && config) {
    showNotice('Для выбранного провайдера не настроен API-ключ на сервере. Добавьте ключ в окружение сервера, перезапустите приложение и обновите страницу.');
  } else if (provider?.configured && !selected) {
    showNotice('На сервере не настроен список моделей для выбранного провайдера.');
  } else if (config) hideNotice();
  updateControls();
}

function setConnection(status, message) {
  phase = status;
  const visual = status === 'ready' ? 'ready' : status === 'connecting' ? 'connecting' : 'neutral';
  ui['connection-badge'].className = `badge ${visual}`;
  ui['connection-label'].textContent = message || (
    status === 'ready' ? 'Подключён' : status === 'connecting' ? 'Подключение…' : 'Не подключён');
  updateControls();
}

function updateControls() {
  const active = phase !== 'stopped';
  ui.provider.disabled = active;
  ui.model.disabled = active || !ui.model.value;
  ui.start.hidden = active;
  ui['start-text'].hidden = active;
  ui.start.disabled = active || !availableProvider();
  ui['start-text'].disabled = active || !availableProvider();
  ui.stop.hidden = !active;
  ui.mute.hidden = !active;
  ui.mute.disabled = phase !== 'ready' || microphonePending;
  ui.mute.setAttribute('aria-pressed', String(muted));
  ui.mute.textContent = microphonePending ? 'Доступ к микрофону…'
    : !microphoneStream ? 'Включить микрофон'
      : muted ? 'Включить микрофон' : 'Выключить микрофон';
  ui.send.disabled = phase !== 'ready' || !ui['text-input'].value.trim();
  ui['text-hint'].textContent = phase === 'ready' ? 'Текстовый канал доступен'
    : phase === 'connecting' ? 'Подключаем голосовую модель…'
      : 'Сначала подключите голосовой или текстовый канал';
  ui.approve.disabled = phase !== 'ready' || !awaitingConfirmation;
  ui.reject.disabled = phase !== 'ready' || !awaitingConfirmation;
  renderVoice();
}

function renderVoice() {
  const speaking = playbackSources.size > 0;
  const listening = phase === 'ready' && microphoneStream && !muted;
  ui['voice-stage'].classList.toggle('listening', Boolean(listening));
  ui['voice-stage'].classList.toggle('speaking', speaking);
  let title = 'Начните с голоса';
  let description = 'Разрешите доступ к микрофону и расскажите, чем помочь.';
  if (phase === 'connecting') {
    title = 'Подключаем ассистента';
    description = 'Создаём сессию с выбранной голосовой моделью.';
  } else if (phase === 'ready') {
    if (speaking) {
      title = 'Ассистент отвечает';
      description = listening ? 'Можно перебить голосом — микрофон остаётся включён.'
        : 'Голосовой ответ воспроизводится в браузере.';
    } else if (microphonePending) {
      title = 'Разрешите доступ к микрофону';
      description = 'Пока можно написать сообщение в текстовом поле.';
    } else if (listening) {
      title = 'Слушаю вас';
      description = 'Говорите по-русски, қазақша или смешивайте языки.';
    } else {
      title = microphoneStream ? 'Микрофон выключен' : 'Текстовый канал готов';
      description = 'Напишите сообщение или включите микрофон.';
    }
  }
  ui['voice-title'].textContent = title;
  ui['voice-description'].textContent = description;
}

function send(data) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(data));
  return true;
}

function flushPlayback() {
  for (const timer of playbackTimers) clearTimeout(timer);
  playbackTimers.clear();
  playbackPendingTurns.clear();
  for (const source of playbackSources) {
    source.onended = null;
    try { source.stop(); } catch { /* The source may already have ended. */ }
    source.disconnect();
  }
  playbackSources.clear();
  nextPlaybackTime = 0;
  renderVoice();
}

function closeContext(context) {
  if (context && context.state !== 'closed') context.close().catch(() => {});
}

function releaseAudio() {
  const stream = microphoneStream;
  microphoneStream = null;
  if (stream) stream.getTracks().forEach((track) => track.stop());
  if (captureWorklet) {
    captureWorklet.port.onmessage = null;
    captureWorklet.disconnect();
  }
  if (captureSource) captureSource.disconnect();
  if (captureGain) captureGain.disconnect();
  captureWorklet = null;
  captureSource = null;
  captureGain = null;
  closeContext(captureContext);
  captureContext = null;
  microphonePending = false;
  flushPlayback();
  closeContext(playbackContext);
  playbackContext = null;
  muted = false;
  level = 0;
  ui['voice-stage'].style.setProperty('--level', '0');
}

function stopSession(notifyServer = true) {
  finishInterruptedTranscripts();
  generation += 1;
  if (notifyServer) send({ type: 'stop' });
  const oldSocket = socket;
  socket = null;
  if (oldSocket && oldSocket.readyState < WebSocket.CLOSING) oldSocket.close();
  releaseAudio();
  wantsMicrophone = false;
  awaitingConfirmation = false;
  setConnection('stopped');
}

async function startSession(withMicrophone) {
  if (phase !== 'stopped' || !availableProvider()) return;
  stopSession(false);
  clearConversation();
  const token = generation;
  const selectedProvider = ui.provider.value;
  const selectedModel = ui.model.value;
  wantsMicrophone = withMicrophone;
  hideNotice();
  blockedTurns.clear();
  playbackReportedTurns.clear();
  if (AudioContextClass) {
    try {
      playbackContext = new AudioContextClass({ latencyHint: 'interactive' });
      playbackContext.resume().catch(() => {
        if (token === generation) showNotice('Браузер приостановил звук. Нажмите «Включить микрофон» или отправьте текстовое сообщение для возобновления.');
      });
    } catch {
      showNotice('Воспроизведение звука недоступно в этом браузере. Текстовый диалог остаётся доступен.');
    }
  } else showNotice('Этот браузер не поддерживает Web Audio. Используйте текстовый канал.');
  setConnection('connecting');
  try {
    const url = new URL('/ws', window.location.href);
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const connection = new WebSocket(url);
    socket = connection;
    connection.addEventListener('open', () => {
      if (token !== generation || connection !== socket) return;
      send({ type: 'start', provider: selectedProvider, model: selectedModel });
    });
    connection.addEventListener('message', (event) => {
      if (token !== generation || connection !== socket) return;
      try { handleMessage(JSON.parse(event.data), token); }
      catch (error) {
        console.error('Server message could not be processed:', error);
        showNotice('Не удалось обработать сообщение сервера. Завершите разговор и подключитесь снова.', true);
      }
    });
    connection.addEventListener('error', () => {
      if (token === generation) showNotice('Ошибка соединения с сервером. Проверьте, что приложение запущено, и подключитесь снова.', true);
    });
    connection.addEventListener('close', () => {
      if (token !== generation || connection !== socket) return;
      stopSession(false);
      showNotice('Соединение завершено. Для нового разговора подключитесь снова.');
    });
  } catch {
    stopSession(false);
    showNotice('Не удалось открыть соединение с сервером.', true);
  }
}

async function startMicrophone(token) {
  if (token !== generation || phase !== 'ready' || microphoneStream || microphonePending) return;
  if (!navigator.mediaDevices?.getUserMedia || !AudioContextClass || !window.AudioWorkletNode) {
    showNotice('Микрофон требует современного браузера и HTTPS или localhost. Текстовый канал доступен.');
    wantsMicrophone = false;
    updateControls();
    return;
  }
  microphonePending = true;
  updateControls();
  let stream = null;
  let context = null;
  let source = null;
  let worklet = null;
  let silentGain = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    if (token !== generation || phase !== 'ready') {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    try { context = new AudioContextClass({ sampleRate: inputSampleRate, latencyHint: 'interactive' }); }
    catch { context = new AudioContextClass({ latencyHint: 'interactive' }); }
    microphoneStream = stream;
    captureContext = context;
    await context.audioWorklet.addModule('/audio-worklet.js');
    await context.resume();
    if (token !== generation || phase !== 'ready') {
      stream.getTracks().forEach((track) => track.stop());
      closeContext(context);
      return;
    }
    if (context.state !== 'running') throw new Error('AUDIO_CONTEXT_SUSPENDED');
    source = context.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(context, 'pcm-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { targetSampleRate: inputSampleRate }
    });
    silentGain = context.createGain();
    silentGain.gain.value = 0;
    worklet.port.onmessage = (event) => {
      if (token !== generation || phase !== 'ready' || muted || !socket || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 1024 * 1024) {
        stopSession();
        showNotice('Соединение не успевает передавать аудио. Разговор остановлен; подключитесь снова или выберите текстовый канал.', true);
        return;
      }
      if (event.data.type !== 'pcm') return;
      level = Math.min(1, Math.max(event.data.rms * 7, level * 0.7));
      ui['voice-stage'].style.setProperty('--level', level.toFixed(3));
      send({ type: 'audio', data: bufferToBase64(event.data.data) });
    };
    source.connect(worklet);
    worklet.connect(silentGain);
    silentGain.connect(context.destination);
    microphoneStream = stream;
    captureContext = context;
    captureSource = source;
    captureWorklet = worklet;
    captureGain = silentGain;
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => {
        if (token !== generation || microphoneStream !== stream) return;
        microphoneStream = null;
        worklet.port.onmessage = null;
        if (phase === 'ready') send({ type: 'audio_end' });
        stream.getTracks().forEach((endedTrack) => endedTrack.stop());
        source.disconnect();
        worklet.disconnect();
        silentGain.disconnect();
        closeContext(context);
        captureContext = null;
        captureSource = null;
        captureWorklet = null;
        captureGain = null;
        muted = false;
        level = 0;
        ui['voice-stage'].style.setProperty('--level', '0');
        showNotice('Доступ к микрофону завершён. Можно включить его снова или продолжить текстом.');
        updateControls();
      });
    }
    muted = false;
  } catch (error) {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    if (source) source.disconnect();
    if (worklet) worklet.disconnect();
    if (silentGain) silentGain.disconnect();
    closeContext(context);
    if (token === generation) {
      if (microphoneStream === stream) microphoneStream = null;
      if (captureContext === context) captureContext = null;
      wantsMicrophone = false;
      const message = error.name === 'NotAllowedError' || error.name === 'SecurityError'
        ? 'Доступ к микрофону не разрешён. Разрешите его в настройках браузера или продолжите текстом.'
        : error.name === 'NotFoundError'
          ? 'Микрофон не найден. Подключите устройство или продолжите текстом.'
          : error.name === 'NotReadableError'
            ? 'Микрофон занят другим приложением или недоступен. Текстовый канал работает.'
            : 'Не удалось включить микрофон. Попробуйте снова или продолжите текстом.';
      showNotice(message, true);
    }
  } finally {
    if (token === generation) {
      microphonePending = false;
      updateControls();
    }
  }
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function playAudio(message, token) {
  if (phase !== 'ready' || token !== generation || !playbackContext) return;
  const turn = String(message.turnId ?? '');
  if (blockedTurns.has(turn)) return;
  if (playbackContext.state !== 'running') {
    showNotice('Браузер приостановил звук. Отправьте сообщение или нажмите кнопку микрофона, чтобы разрешить воспроизведение.');
    return;
  }
  const binary = atob(message.data);
  if (binary.length < 2 || binary.length % 2 !== 0) return;
  const sampleRate = Number(message.sampleRate) || 24000;
  if (sampleRate < 8000 || sampleRate > 96000) return;
  const buffer = playbackContext.createBuffer(1, binary.length / 2, sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i += 1) {
    let pcm = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
    if (pcm >= 32768) pcm -= 65536;
    samples[i] = pcm / 32768;
  }
  const source = playbackContext.createBufferSource();
  source.buffer = buffer;
  source.connect(playbackContext.destination);
  const startsAt = Math.max(playbackContext.currentTime + 0.015, nextPlaybackTime);
  source.start(startsAt);
  nextPlaybackTime = startsAt + buffer.duration;
  playbackSources.add(source);
  source.onended = () => {
    playbackSources.delete(source);
    source.disconnect();
    renderVoice();
  };
  if (!playbackReportedTurns.has(turn) && !playbackPendingTurns.has(turn)) {
    playbackPendingTurns.add(turn);
    const timer = setTimeout(() => {
      playbackTimers.delete(timer);
      playbackPendingTurns.delete(turn);
      if (token !== generation || phase !== 'ready' || blockedTurns.has(turn) || playbackContext?.state !== 'running') return;
      playbackReportedTurns.add(turn);
      send({ type: 'playback_started', turnId: message.turnId, at: Date.now() });
    }, Math.max(0, (startsAt - playbackContext.currentTime) * 1000));
    playbackTimers.add(timer);
  }
  renderVoice();
}

function handleMessage(message, token) {
  switch (message.type) {
    case 'history': {
      if (/^\/history\.html\?id=[a-f0-9-]{36}$/i.test(message.url || '')) {
        const link = byId('history-link'); link.href = message.url; link.hidden = false;
        byId('history-storage').textContent = message.persistent ? 'История сохраняется в PostgreSQL' : 'История в памяти до перезапуска';
        try { localStorage.setItem('voice-router:last-history', message.url); } catch { /* storage can be disabled */ }
      }
      break;
    }
    case 'status':
      if (message.status === 'ready') {
        inputSampleRate = message.inputSampleRate === 16000 ? 16000 : 24000;
        setConnection('ready');
        if (wantsMicrophone) startMicrophone(token);
      } else if (message.status === 'connecting') setConnection('connecting');
      else if (message.status === 'stopped') stopSession(false);
      if (message.message) showNotice(message.message);
      break;
    case 'transcript':
      renderTranscript(message);
      break;
    case 'audio':
      playAudio(message, token);
      break;
    case 'interrupt':
      finishInterruptedTranscripts(message.turnId);
      if (message.turnId !== undefined) blockedTurns.add(String(message.turnId));
      flushPlayback();
      break;
    case 'trace':
      renderTrace(message);
      break;
    case 'metrics': {
      const turn = String(message.turnId ?? '');
      metrics.set(turn, { ...metrics.get(turn), ...message.latency_ms });
      if (currentTurn === null || turn === currentTurn) renderMetrics(metrics.get(turn));
      break;
    }
    case 'error':
      showNotice(message.message || 'Произошла ошибка сервера.', true);
      if (phase === 'connecting') stopSession(false);
      break;
    case 'reset':
      stopSession(false);
      clearConversation();
      break;
    default:
      break;
  }
}

function finishInterruptedTranscripts(turnId) {
  for (const [key, item] of messages) {
    if (turnId !== undefined && !key.startsWith(`${turnId}:`)) continue;
    if (!item.wrapper.classList.contains('pending')) continue;
    item.wrapper.classList.remove('pending');
    item.progress.textContent = 'Прервано';
    item.progress.hidden = false;
  }
}
function renderTranscript(message) {
  if (message.role === 'assistant' && blockedTurns.has(String(message.turnId ?? ''))) return;
  if (!['user', 'assistant'].includes(message.role) || typeof message.text !== 'string') return;
  const key = `${message.turnId ?? ''}:${message.role}`;
  let item = messages.get(key);
  const nearBottom = ui.transcript.scrollHeight - ui.transcript.scrollTop - ui.transcript.clientHeight < 80;
  if (!item) {
    ui['conversation-empty'].hidden = true;
    const wrapper = element('article', `message ${message.role}`);
    const label = element('div', 'message-label');
    label.append(element('strong', '', message.role === 'user' ? 'Вы' : 'VoiceRouter'));
    const time = element('time', '', new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
    label.append(time);
    const bubble = element('div', 'message-bubble');
    const progress = element('span', 'message-progress', '…');
    wrapper.append(label, bubble, progress);
    ui.transcript.append(wrapper);
    item = { wrapper, bubble, progress };
    messages.set(key, item);
    ui['message-count'].textContent = String(messages.size);
  }
  item.bubble.textContent = message.text;
  item.wrapper.classList.toggle('pending', message.final !== true);
  item.progress.hidden = message.final === true;
  if (nearBottom) ui.transcript.scrollTop = ui.transcript.scrollHeight;
}

function scenarioName(id) {
  if (id === null || id === undefined || id === '') return '—';
  return catalog.get(String(id))?.name || String(id);
}

function confidenceValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

function renderTrace(message) {
  const trace = message.trace || {};
  const serverState = message.state ?? {};
  currentTurn = String(message.turnId ?? '');
  metrics.set(currentTurn, { ...metrics.get(currentTurn), ...message.latency_ms });
  renderMetrics(metrics.get(currentTurn));
  ui['route-empty'].hidden = true;
  ui['route-results'].hidden = false;
  ui['trace-turn'].textContent = `Реплика ${message.turnId ?? '—'}`;
  const language = { ru: 'Русский', kk: 'Қазақша', mixed: 'RU + KK', 'ru-kk': 'RU + KK' }[trace.language] || trace.language || '—';
  ui['trace-language'].textContent = `Язык: ${language}`;
  const status = trace.status || 'active';
  ui['route-status'].textContent = statusLabels[status] || status;
  ui['route-status'].className = `badge ${status === 'error' ? 'error' : 'ready'}`;
  ui.scenarios.replaceChildren();
  for (const scenario of Array.isArray(trace.scenarios) ? trace.scenarios : []) {
    const card = element('article', 'scenario');
    const heading = element('div', 'scenario-heading');
    heading.append(element('h3', '', scenarioName(scenario.scenario_id)));
    const confidence = confidenceValue(scenario.confidence);
    heading.append(element('span', 'confidence', confidence === null ? '—' : `${Math.round(confidence * 100)}%`));
    card.append(heading, element('div', 'scenario-id', scenario.scenario_id),
      element('p', 'scenario-reason', scenario.reason || 'Объяснение не передано.'));
    if (confidence !== null) {
      const track = element('div', 'confidence-track');
      const bar = element('div', 'confidence-bar');
      bar.style.width = `${confidence * 100}%`;
      track.append(bar);
      card.append(track);
    }
    ui.scenarios.append(card);
  }
  if (!ui.scenarios.childElementCount) ui.scenarios.append(element('p', 'inline-empty', 'Сценарий пока не выбран.'));
  ui.alternatives.replaceChildren();
  for (const alternative of Array.isArray(trace.alternatives) ? trace.alternatives : []) {
    const chip = element('span', 'alternative', scenarioName(alternative.scenario_id));
    const confidence = confidenceValue(alternative.confidence);
    if (confidence !== null) chip.append(element('strong', '', `${Math.round(confidence * 100)}%`));
    ui.alternatives.append(chip);
  }
  if (!ui.alternatives.childElementCount) ui.alternatives.append(element('span', 'quiet-label', 'Не предложены'));
  renderSlots(trace.slots ?? serverState.slots ?? {});
  ui['active-scenario'].textContent = scenarioName(trace.active_scenario ?? serverState.active_scenario);
  const queued = trace.queued_scenarios ?? serverState.queued_scenarios ?? [];
  ui['queued-scenarios'].textContent = Array.isArray(queued) && queued.length
    ? queued.map((entry) => scenarioName(typeof entry === 'object' ? entry.scenario_id : entry)).join(' · ') : '—';
  ui['server-state'].textContent = stringify(serverState);
  renderActions(trace.actions);
  renderConfirmation(trace.confirmation);
}

function renderSlots(slots) {
  const entries = typeof slots === 'object' && slots !== null ? Object.entries(slots) : [];
  ui['slot-count'].textContent = String(entries.length);
  ui.slots.replaceChildren();
  if (!entries.length) {
    ui.slots.append(element('p', 'inline-empty', 'Извлечённые данные появятся здесь.'));
    return;
  }
  const table = element('table', 'slots-table');
  table.setAttribute('aria-label', 'Извлечённые данные');
  const body = element('tbody');
  for (const [key, value] of entries) {
    const row = element('tr');
    const name = element('td', '', slotLabels[key] || key);
    name.title = key;
    row.append(name, element('td', '', stringify(value)));
    body.append(row);
  }
  table.append(body);
  ui.slots.append(table);
}

function renderActions(actions) {
  const list = Array.isArray(actions) ? actions : [];
  ui['action-count'].textContent = String(list.length);
  ui.actions.replaceChildren();
  if (!list.length) {
    ui.actions.append(element('p', 'inline-empty', 'Для этой реплики действий пока нет.'));
    return;
  }
  for (const action of list) {
    const card = element('article', 'action');
    const heading = element('div', 'action-heading');
    heading.append(element('strong', '', action.action_id || action.name || action.action || 'Действие'));
    const status = action.status ?? action.result?.status;
    const failed = status === 'error' || status === 'failed' || action.error || action.result?.error;
    const badge = element('span', `badge ${failed ? 'error' : status ? 'ready' : 'neutral'}`,
      failed ? 'Ошибка' : statusLabels[status] || status || 'Результат');
    heading.append(badge);
    const details = element('details');
    details.append(element('summary', '', 'Фактический результат'), element('pre', '', stringify(action)));
    card.append(heading, details);
    ui.actions.append(card);
  }
}

function renderConfirmation(confirmation) {
  awaitingConfirmation = Boolean(confirmation);
  ui.confirmation.hidden = !awaitingConfirmation;
  if (confirmation) {
    ui['confirmation-description'].textContent = typeof confirmation === 'string' ? confirmation
      : confirmation.message || confirmation.prompt || confirmation.summary || confirmation.description
        || 'Проверьте детали. Выполнить это действие можно только после вашего согласия.';
    ui['confirmation-data'].textContent = stringify(confirmation);
    ui['confirmation-details'].open = false;
  }
  updateControls();
}

function formatTiming(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'недоступно';
  return value >= 1000 ? `${(value / 1000).toFixed(2)} с` : `${Math.round(value)} мс`;
}

function renderMetrics(values) {
  for (const [id, key] of [
    ['metric-first', 'end_to_first_audio'], ['metric-route', 'route'],
    ['metric-backend', 'backend'], ['metric-transcript', 'transcript']
  ]) {
    const display = values && Object.hasOwn(values, key) ? formatTiming(values[key]) : '—';
    ui[id].textContent = display;
    ui[id].style.fontSize = display === 'недоступно' ? '12px' : '';
    ui[id].style.letterSpacing = display === 'недоступно' ? '0' : '';
  }
}

function clearConversation() {
  for (const item of messages.values()) item.wrapper.remove();
  messages.clear();
  metrics.clear();
  currentTurn = null;
  awaitingConfirmation = false;
  ui['conversation-empty'].hidden = false;
  ui['message-count'].textContent = '0';
  ui['route-empty'].hidden = false;
  ui['route-results'].hidden = true;
  ui['route-status'].textContent = 'Ожидание';
  ui['route-status'].className = 'badge neutral';
  ui.scenarios.replaceChildren();
  ui.alternatives.replaceChildren();
  ui['active-scenario'].textContent = '—';
  ui['queued-scenarios'].textContent = '—';
  ui['server-state'].textContent = 'Сессия ещё не началась.';
  ui.confirmation.hidden = true;
  ui['text-input'].value = '';
  ui['text-input'].style.height = '23px';
  renderSlots({});
  renderActions([]);
  renderMetrics(null);
  updateControls();
}

function resumePlayback() {
  if (playbackContext && playbackContext.state === 'suspended') {
    playbackContext.resume().catch(() => showNotice('Не удалось возобновить звук. Проверьте разрешения браузера.'));
  }
}

ui.start.addEventListener('click', () => startSession(true));
ui['start-text'].addEventListener('click', () => startSession(false));
ui.stop.addEventListener('click', () => stopSession());
ui.provider.addEventListener('change', renderProvider);
ui.model.addEventListener('change', () => {
  if (phase !== 'stopped') return;
  selectedModels.set(ui.provider.value, ui.model.value);
  renderModelGuidance();
  updateControls();
});
ui['dismiss-notice'].addEventListener('click', hideNotice);
ui.mute.addEventListener('click', () => {
  if (phase !== 'ready') return;
  resumePlayback();
  if (!microphoneStream) {
    wantsMicrophone = true;
    startMicrophone(generation);
    return;
  }
  muted = !muted;
  microphoneStream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  if (muted) send({ type: 'audio_end' });
  if (!muted && captureContext?.state === 'suspended') captureContext.resume().catch(() => {});
  ui['voice-stage'].style.setProperty('--level', '0');
  updateControls();
});
ui.reset.addEventListener('click', () => {
  send({ type: 'reset' });
  stopSession(false);
  clearConversation();
  hideNotice();
});
ui['text-input'].addEventListener('input', () => {
  ui['text-input'].style.height = '23px';
  ui['text-input'].style.height = `${Math.min(ui['text-input'].scrollHeight, 110)}px`;
  updateControls();
});
ui['text-input'].addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    ui['text-form'].requestSubmit();
  }
});
ui['text-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  const text = ui['text-input'].value.trim();
  if (!text || phase !== 'ready') return;
  resumePlayback();
  flushPlayback();
  if (send({ type: 'text', text })) {
    ui['text-input'].value = '';
    ui['text-input'].style.height = '23px';
    updateControls();
  }
});
for (const prompt of document.querySelectorAll('[data-prompt]')) {
  prompt.addEventListener('click', () => {
    ui['text-input'].value = prompt.dataset.prompt;
    ui['text-input'].dispatchEvent(new Event('input'));
    ui['text-input'].focus();
  });
}
for (const [id, approved] of [['approve', true], ['reject', false]]) {
  ui[id].addEventListener('click', () => {
    if (!awaitingConfirmation || phase !== 'ready') return;
    resumePlayback();
    if (send({ type: 'confirm', approved })) {
      awaitingConfirmation = false;
      ui['confirmation-description'].textContent = approved
        ? 'Подтверждение отправлено. Ожидаем результат сервера.'
        : 'Отмена отправлена. Ожидаем ответ сервера.';
      updateControls();
    }
  });
}
window.addEventListener('pagehide', () => stopSession());

async function loadConfig() {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    config = await response.json();
    catalog = new Map((config.catalog || []).map((entry) => [String(entry.id), entry]));
    if (!config.providers?.openai?.configured && config.providers?.gemini?.configured) ui.provider.value = 'gemini';
    if (config.asOfDate) {
      const date = new Date(`${config.asOfDate}T12:00:00Z`);
      if (!Number.isNaN(date.getTime())) ui['as-of-date'].textContent = date.toLocaleDateString('ru-RU', { timeZone: 'UTC' });
    }
    ui['catalog-summary'].textContent = '40 сценариев · 3 системных намерения · RU / KK';
    renderProvider();
  } catch {
    ui['provider-availability'].textContent = 'Сервер недоступен';
    showNotice('Не удалось загрузить конфигурацию. Проверьте запуск сервера и обновите страницу.', true);
    updateControls();
  }
}

loadConfig();

try {
  const previous = localStorage.getItem('voice-router:last-history');
  if (/^\/history\.html\?id=[a-f0-9-]{36}$/i.test(previous || '')) { byId('history-link').href = previous; byId('history-link').hidden = false; }
} catch { /* browser storage is optional */ }
