import { Pool } from 'pg';

const MAX_SESSIONS = 100;
const MAX_TURNS = 500;
const MEMORY_SESSIONS = 200;
const MEMORY_TURNS = 1000;
const SCHEMA = `
BEGIN;
SELECT pg_advisory_xact_lock(867342019);
CREATE TABLE IF NOT EXISTS voice_sessions (
  id text PRIMARY KEY,
  provider text NOT NULL,
  model text NOT NULL,
  owner_hash text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz
);
ALTER TABLE voice_sessions ADD COLUMN IF NOT EXISTS owner_hash text;
CREATE INDEX IF NOT EXISTS voice_sessions_started_idx ON voice_sessions (started_at DESC);
CREATE TABLE IF NOT EXISTS voice_turns (
  session_id text NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
  turn_id text NOT NULL,
  ordinal bigserial NOT NULL,
  transcript text NOT NULL DEFAULT '',
  reply text NOT NULL DEFAULT '',
  trace jsonb NOT NULL DEFAULT '{}'::jsonb,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  latency jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (session_id, turn_id)
);
CREATE INDEX IF NOT EXISTS voice_turns_order_idx ON voice_turns (session_id, ordinal);
COMMIT;`;

function id(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new TypeError(`${field} must be a nonempty string of at most 200 characters`);
  return value;
}
function owner(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new TypeError('ownerHash must be a SHA-256 hex string');
  return value.toLowerCase();
}
function limit(value, fallback, max) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? Math.max(1, Math.min(max, Math.trunc(number))) : fallback;
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function timestamp(value) { return value instanceof Date ? value.toISOString() : value; }
function sessionRow(row) {
  return { id: row.id, provider: row.provider, model: row.model, ownerHash: row.owner_hash ?? null, startedAt: timestamp(row.started_at), endedAt: timestamp(row.ended_at) ?? null, turnCount: Number(row.turn_count ?? 0) };
}
function turnRow(row) {
  return { sessionId: row.session_id, turnId: row.turn_id, transcript: row.transcript, reply: row.reply,
    trace: row.trace, state: row.state, latency: row.latency, actions: row.trace?.actions ?? [],
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) };
}
function payloadOf(input) {
  const payload = {};
  for (const key of ['transcript', 'reply']) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string' || input[key].length > 65536) throw new TypeError(`${key} must be a string of at most 65536 characters`);
    payload[key] = input[key];
  }
  for (const key of ['trace', 'state', 'latency']) {
    if (input[key] === undefined) continue;
    const value = input[key] ?? {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${key} must be an object`);
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > 262144) throw new TypeError(`${key} exceeds the audit record size limit`);
    payload[key] = JSON.parse(serialized);
  }
  return payload;
}

// This is an audit store. It never restores the live conversation state or saves audio.
// Callers must authorize access before exposing listSessions/getSession over HTTP.
export function createHistory({ env = process.env, poolFactory = options => new Pool(options) } = {}) {
  const persistent = Boolean(env.DATABASE_URL?.trim());
  const health = { backend: persistent ? 'postgres' : 'memory', persistent, ready: !persistent, available: !persistent, error: null };
  let closed = false;
  let closing;
  const sessions = new Map();
  const pool = persistent ? poolFactory({ connectionString: env.DATABASE_URL, max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000, statement_timeout: 10000 }) : null;
  function unavailable() {
    health.available = false;
    health.error = 'History database is unavailable';
    return new Error(health.error);
  }
  pool?.on('error', unavailable);
  const ready = pool ? pool.query(SCHEMA).then(() => {
    if (!closed) { health.ready = true; health.available = true; health.error = null; }
  }, () => { throw unavailable(); }) : Promise.resolve();
  // Initialization can begin before the server awaits ready; keep that interval safe.
  ready.catch(() => {});
  async function ensure() {
    if (closed) throw new Error('History store is closed');
    await ready;
    if (closed) throw new Error('History store is closed');
  }
  async function query(sql, values) {
    try {
      const result = await pool.query(sql, values);
      health.available = true; health.error = null;
      return result;
    } catch { throw unavailable(); }
  }
  async function startSession({ id: sessionId, provider, model, ownerHash }) {
    id(sessionId, 'id'); id(provider, 'provider'); id(model, 'model');
    const ownerValue = owner(ownerHash);
    await ensure();
    if (pool) {
      const { rows } = await query(`INSERT INTO voice_sessions(id, provider, model, owner_hash) VALUES($1, $2, $3, $4)
        ON CONFLICT(id) DO UPDATE SET id = EXCLUDED.id
        WHERE voice_sessions.owner_hash IS NOT DISTINCT FROM EXCLUDED.owner_hash
        RETURNING *, (SELECT COUNT(*) FROM voice_turns WHERE session_id = $1) AS turn_count`, [sessionId, provider, model, ownerValue]);
      if (!rows.length) throw new Error('History session owner mismatch');
      return sessionRow(rows[0]);
    }
    if (!sessions.has(sessionId)) {
      if (sessions.size >= MEMORY_SESSIONS) sessions.delete(sessions.keys().next().value);
      sessions.set(sessionId, { id: sessionId, provider, model, ownerHash: ownerValue, startedAt: new Date().toISOString(), endedAt: null, turns: new Map() });
    }
    const session = sessions.get(sessionId);
    if (session.ownerHash !== ownerValue) throw new Error('History session owner mismatch');
    return { ownerHash: session.ownerHash, id: session.id, provider: session.provider, model: session.model, startedAt: session.startedAt, endedAt: session.endedAt, turnCount: session.turns.size };
  }
  async function saveTurn(input) {
    const sessionId = id(input.sessionId, 'sessionId'), turnId = id(input.turnId, 'turnId');
    const payload = payloadOf(input);
    await ensure();
    if (pool) {
      const { rows } = await query(`INSERT INTO voice_turns(session_id, turn_id, transcript, reply, trace, state, latency)
        VALUES($1, $2, COALESCE($3::jsonb->>'transcript', ''), COALESCE($3::jsonb->>'reply', ''),
          COALESCE($3::jsonb->'trace', '{}'::jsonb), COALESCE($3::jsonb->'state', '{}'::jsonb), COALESCE($3::jsonb->'latency', '{}'::jsonb))
        ON CONFLICT(session_id, turn_id) DO UPDATE SET
          transcript = CASE WHEN $3::jsonb ? 'transcript' THEN EXCLUDED.transcript ELSE voice_turns.transcript END,
          reply = CASE WHEN $3::jsonb ? 'reply' THEN EXCLUDED.reply ELSE voice_turns.reply END,
          trace = CASE WHEN $3::jsonb ? 'trace' THEN EXCLUDED.trace ELSE voice_turns.trace END,
          state = CASE WHEN $3::jsonb ? 'state' THEN EXCLUDED.state ELSE voice_turns.state END,
          latency = CASE WHEN $3::jsonb ? 'latency' THEN EXCLUDED.latency ELSE voice_turns.latency END,
          updated_at = clock_timestamp()
        RETURNING *`, [sessionId, turnId, JSON.stringify(payload)]);
      return turnRow(rows[0]);
    }
    const session = sessions.get(sessionId);
    if (!session) throw new Error('History session does not exist');
    const now = new Date().toISOString();
    const old = session.turns.get(turnId);
    if (!old && session.turns.size >= MEMORY_TURNS) session.turns.delete(session.turns.keys().next().value);
    const turn = { sessionId, turnId, transcript: '', reply: '', trace: {}, state: {}, latency: {}, createdAt: now, ...old, ...payload, updatedAt: now };
    turn.actions = turn.trace?.actions ?? [];
    session.turns.set(turnId, turn);
    return copy(turn);
  }
  async function endSession(sessionId) {
    id(sessionId, 'id'); await ensure();
    if (pool) {
      await query('UPDATE voice_sessions SET ended_at = COALESCE(ended_at, clock_timestamp()) WHERE id = $1', [sessionId]);
    } else {
      const session = sessions.get(sessionId);
      if (session && !session.endedAt) session.endedAt = new Date().toISOString();
    }
  }
  async function listSessions({ limit: requestedLimit = 50 } = {}) {
    await ensure();
    const count = limit(requestedLimit, 50, MAX_SESSIONS);
    if (pool) {
      const { rows } = await query(`SELECT s.*, (SELECT COUNT(*) FROM voice_turns t WHERE t.session_id = s.id) AS turn_count
        FROM voice_sessions s ORDER BY s.started_at DESC, s.id DESC LIMIT $1`, [count]);
      return rows.map(sessionRow);
    }
    return [...sessions.values()].reverse().slice(0, count).map(({ turns, ...session }) => ({ ...session, turnCount: turns.size }));
  }
  async function getSession(sessionId, { limit: requestedLimit = 200, ownerHash } = {}) {
    id(sessionId, 'id');
    const ownerValue = owner(ownerHash);
    await ensure();
    const count = limit(requestedLimit, 200, MAX_TURNS);
    if (pool) {
      // One SQL statement gives session metadata and turns the same database snapshot.
      const { rows } = await query(`SELECT s.*,
        (SELECT COUNT(*) FROM voice_turns t WHERE t.session_id = s.id) AS turn_count,
        COALESCE((SELECT jsonb_agg(to_jsonb(recent) ORDER BY recent.ordinal) FROM
          (SELECT * FROM voice_turns WHERE session_id = s.id ORDER BY ordinal LIMIT $2) recent), '[]'::jsonb) AS turns
        FROM voice_sessions s WHERE s.id = $1 AND ($3::text IS NULL OR s.owner_hash = $3)`, [sessionId, count, ownerValue]);
      if (!rows.length) return null;
      const session = sessionRow(rows[0]);
      const turns = rows[0].turns.map(turnRow);
      return { ...session, turns, turnsTruncated: session.turnCount > turns.length };
    }
    const session = sessions.get(sessionId);
    if (!session || (ownerValue !== null && session.ownerHash !== ownerValue)) return null;
    const { turns, ...metadata } = session;
    const selected = [...turns.values()].slice(0, count);
    return copy({ ...metadata, turnCount: turns.size, turns: selected, turnsTruncated: turns.size > selected.length });
  }
  function close() {
    if (!closing) {
      closed = true; health.ready = false; health.available = false;
      closing = ready.catch(() => {}).then(() => pool?.end()).then(() => { sessions.clear(); });
    }
    return closing;
  }
  return { ready, get status() { return { ...health }; }, startSession, saveTurn, endSession, listSessions, getSession, close };
}
