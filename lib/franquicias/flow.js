// lib/franquicias/flow.js
// Flujo automático "Franquicias ULAL" (Click-to-WhatsApp)
//
//   1) inmediato  -> únete a la comunidad
//   2) +6 h       -> infórmate (landing)
//   3) +12 h      -> ¿ya te uniste?
//   4) +23 h      -> último mensaje
//
// Todo va como texto libre dentro de la ventana de 24 h (sin plantillas).
// Estado en Neon (mismo DATABASE_URL que stripe-webhook).
//
// Lo usan:
//   api/meta-webhook.js     -> handleFranquiciasPayload(payload)   (mensajes entrantes)
//   api/franquicias-cron.js -> processDueLeads() / getStats()      (cron externo)

import { neon } from '@neondatabase/serverless';
import { MESSAGES, OPT_OUT_REPLY, SUPPORT_REDIRECT, CLARIFY_FALLBACK } from './messages.js';
import { classifyLead, aiConfig } from './classifier.js';

/* ------------------------------- config -------------------------------- */

const env = process.env;
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  enabled: (env.FRANQ_ENABLED || 'true') === 'true',
  // Número desde el que corre el flujo. Por defecto el mismo que usa Stripe.
  phoneNumberId: env.FRANQ_PHONE_NUMBER_ID || env.WHATSAPP_PHONE_NUMBER_ID,
  token: env.WHATSAPP_TOKEN,
  graphVersion: env.WHATSAPP_GRAPH_VERSION || 'v23.0',
  community: env.FRANQ_COMMUNITY_LINK || 'https://chat.whatsapp.com/IUeFFiRZ8zrJWGsajKDqri',
  landing: env.FRANQ_LANDING_URL || 'https://franquicias.ulalmexico.com',
  offsetsMs: [0, ...list(env.FRANQ_FOLLOWUP_HOURS || '6,12,23').map(Number)].map((h) => h * 3600e3),
  // Solo inicia el flujo si el texto contiene una de estas frases (sin acentos ni mayúsculas)...
  keywords: list(env.FRANQ_KEYWORDS || 'escuela digital,franquicia').map(normalize),
  // ...o si el mensaje viene de un anuncio Click-to-WhatsApp.
  referralTriggers: (env.FRANQ_REFERRAL_TRIGGERS || 'true') === 'true',
  // Opcional: limitar el disparo por anuncio a estos IDs de anuncio (source_id).
  adIds: list(env.FRANQ_AD_IDS),
  restartAfterDays: Number(env.FRANQ_RESTART_AFTER_DAYS || 7),
  // Teléfono de recepción / atención al cliente para lo que no es de franquicias.
  supportPhone: env.FRANQ_SUPPORT_PHONE || '614 212 3175',
  // false = Claude solo clasifica; no pregunta ni manda a recepción.
  triageReplies: (env.FRANQ_TRIAGE_REPLIES || 'true') === 'true',
};

// Se envía en cada mensaje del flujo; Meta lo devuelve en los "statuses".
// meta-webhook lo usa para NO reenviar esos estados a Apps Script.
export const CALLBACK_TAG = 'franq_flow';

const OPT_OUT_WORDS = ['baja', 'stop', 'alto', 'cancelar', 'no molestar', 'darme de baja'];
const WINDOW_MS = 24 * 3600e3;
const WINDOW_SAFETY_MS = 10 * 60e3;  // no enviar en los últimos 10 min de la ventana
const MIN_GAP_MS = 60 * 60e3;        // mínimo 1 h entre mensajes si el cron se atrasó
const RETRY_DELAY_MS = 5 * 60e3;
const MAX_ATTEMPTS = 3;
const CRON_BATCH = 50;

if (MESSAGES.length !== config.offsetsMs.length) {
  console.warn(`[franq] ${MESSAGES.length} mensajes pero ${config.offsetsMs.length} tiempos. Revisa FRANQ_FOLLOWUP_HOURS.`);
}

/* ---------------------------- base de datos ---------------------------- */

let _sql = null;
const sql = (...args) => {
  _sql ??= neon(env.DATABASE_URL || env.POSTGRES_URL);
  return _sql(...args);
};
// Solo para pruebas locales
export function __setSql(fn) { _sql = fn; schemaReady = undefined; }

let schemaReady;
export function ensureSchema() {
  schemaReady ??= (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS franquicia_leads (
        phone            TEXT PRIMARY KEY,
        push_name        TEXT NOT NULL DEFAULT '',
        status           TEXT NOT NULL DEFAULT 'active', -- active|completed|stopped|expired|failed
        step             INTEGER NOT NULL DEFAULT 0,     -- mensajes del flujo ya enviados
        started_at       TIMESTAMPTZ NOT NULL,
        last_inbound_at  TIMESTAMPTZ NOT NULL,           -- abre la ventana de 24 h
        next_at          TIMESTAMPTZ,
        attempts         INTEGER NOT NULL DEFAULT 0,
        locked_until     TIMESTAMPTZ,
        first_text       TEXT NOT NULL DEFAULT '',
        referral         JSONB,
        history          JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS franquicia_leads_due ON franquicia_leads (next_at) WHERE status = 'active'`;
    // Cómo entró el lead al flujo: keyword | referral | ai
    await sql`ALTER TABLE franquicia_leads ADD COLUMN IF NOT EXISTS trigger_source TEXT`;
    // Mensajes de contactos nuevos que NO dispararon el flujo por regla fija.
    // Guarda el veredicto de Claude y qué se hizo, para medir y rescatar leads.
    await sql`
      CREATE TABLE IF NOT EXISTS franquicia_unmatched (
        id             BIGSERIAL PRIMARY KEY,
        message_id     TEXT,
        phone          TEXT NOT NULL,
        push_name      TEXT NOT NULL DEFAULT '',
        msg_type       TEXT NOT NULL DEFAULT '',
        text           TEXT NOT NULL DEFAULT '',
        is_reply       BOOLEAN NOT NULL DEFAULT false,
        has_referral   BOOLEAN NOT NULL DEFAULT false,
        ai_intent      TEXT,
        ai_confidence  REAL,
        ai_reason      TEXT,
        action         TEXT NOT NULL,  -- started | asked | redirected | skipped | ai_off | ai_error | no_text | send_error
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS franquicia_unmatched_created ON franquicia_unmatched (created_at DESC)`;
    await sql`ALTER TABLE franquicia_unmatched ADD COLUMN IF NOT EXISTS bot_reply TEXT`;
    // Conversación de aclaración con contactos que aún no son leads.
    await sql`
      CREATE TABLE IF NOT EXISTS franquicia_triage (
        phone          TEXT PRIMARY KEY,
        turns          INTEGER NOT NULL DEFAULT 0,       -- preguntas aclaratorias enviadas
        status         TEXT NOT NULL DEFAULT 'new',      -- new | asking | redirected | started
        history        JSONB NOT NULL DEFAULT '[]'::jsonb,
        last_reply_at  TIMESTAMPTZ,
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    // Idempotencia: un reintento de Meta del mismo mensaje no se procesa dos veces
    await sql`
      CREATE TABLE IF NOT EXISTS franquicia_inbound (
        message_id  TEXT PRIMARY KEY,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
  })().catch((err) => { schemaReady = undefined; throw err; });
  return schemaReady;
}

/* ------------------------- 1) mensajes entrantes ------------------------ */

// Recibe el payload completo de Meta. Nunca lanza error (no debe romper el relay).
export async function handleFranquiciasPayload(payload) {
  if (!config.enabled) return;
  try {
    await ensureSchema();
    for (const entry of payload?.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const pnid = value.metadata?.phone_number_id;
        if (pnid && config.phoneNumberId && pnid !== config.phoneNumberId) continue;

        const contacts = value.contacts || [];
        for (const message of value.messages || []) {
          const contact = contacts.find((c) => c.wa_id === message.from) || contacts[0];
          await handleInbound(message, contact).catch((err) =>
            console.error('[franq] error procesando mensaje', message.id, err));
        }
      }
    }
  } catch (err) {
    console.error('[franq] error general', err);
  }
}

async function handleInbound(message, contact) {
  // Idempotencia por message.id
  if (message.id) {
    const fresh = await sql`
      INSERT INTO franquicia_inbound (message_id) VALUES (${message.id})
      ON CONFLICT (message_id) DO NOTHING RETURNING message_id`;
    if (!fresh.length) return;
  }

  try {
    await processInbound(message, contact);
  } catch (err) {
    // Liberar para que el reintento de Meta lo vuelva a intentar
    if (message.id) await sql`DELETE FROM franquicia_inbound WHERE message_id = ${message.id}`.catch(() => {});
    throw err;
  }
}

async function processInbound(message, contact) {
  const phone = message.from;
  const pushName = contact?.profile?.name || '';
  const text = extractText(message);
  const norm = normalize(text);
  const now = new Date();

  // Actualiza la ventana de 24 h si es un lead del flujo
  const [existing] = await sql`
    UPDATE franquicia_leads SET last_inbound_at = ${iso(now)}, updated_at = now()
    WHERE phone = ${phone} RETURNING *`;

  // Baja voluntaria (solo leads del flujo, para no contestarle a alumnos/maestros)
  if (existing && existing.status !== 'stopped' && OPT_OUT_WORDS.includes(norm)) {
    await sql`
      UPDATE franquicia_leads SET status = 'stopped', next_at = NULL, locked_until = NULL, updated_at = now()
      WHERE phone = ${phone}`;
    await sendText(phone, OPT_OUT_REPLY, false);
    console.log('[franq] baja', phone);
    return;
  }

  const triggered = shouldTrigger(norm, message.referral);

  // Contacto nuevo
  if (!existing) {
    let source = triggered;
    // Las reglas fijas no dispararon: Claude decide si aun así es un lead.
    // Si no lo es (alumno, maestro, etc.) no es asunto del flujo.
    if (!source && await classifyUnmatched(message, { phone, pushName, text })) source = 'ai';
    if (!source) return;

    const [lead] = await sql`
      INSERT INTO franquicia_leads (phone, push_name, started_at, last_inbound_at, next_at, first_text, referral, trigger_source)
      VALUES (${phone}, ${pushName}, ${iso(now)}, ${iso(now)}, ${iso(new Date(now.getTime() + RETRY_DELAY_MS))},
              ${text.slice(0, 300)}, ${message.referral ? JSON.stringify(message.referral) : null}::jsonb, ${source})
      ON CONFLICT (phone) DO NOTHING
      RETURNING *`;
    if (lead) {
      console.log('[franq] nuevo lead', phone, `(${source})`);
      await sendStep(lead, 0);
    }
    return;
  }

  // Vuelve a escribir el disparador tiempo después de terminar: reiniciar
  const ageMs = now - new Date(existing.started_at);
  if (triggered
      && ['completed', 'expired', 'failed'].includes(existing.status)
      && ageMs > config.restartAfterDays * 86400e3) {
    const [lead] = await sql`
      UPDATE franquicia_leads
      SET status = 'active', step = 0, attempts = 0, started_at = ${iso(now)},
          next_at = ${iso(new Date(now.getTime() + RETRY_DELAY_MS))}, locked_until = NULL,
          referral = COALESCE(${message.referral ? JSON.stringify(message.referral) : null}::jsonb, referral),
          updated_at = now()
      WHERE phone = ${phone} AND status = ${existing.status}
      RETURNING *`;
    if (lead) {
      console.log('[franq] flujo reiniciado', phone);
      await sendStep(lead, 0);
    }
  }
  // Cualquier otro mensaje solo extiende la ventana (sin respuesta automática).
}

/* ------------------- 1b) respaldo con Claude + registro ------------------ */

// Tipos de mensaje que no son una conversación (no se clasifican ni registran).
const IGNORED_TYPES = ['reaction', 'system', 'unsupported', 'ephemeral', 'request_welcome'];

// Decide qué hacer con el mensaje de un contacto nuevo que no disparó por regla
// fija. Devuelve true solo si hay que iniciar el flujo de franquicia.
//
//   franquicia (confianza suficiente)  -> true: inicia el flujo
//   atencion   (confianza suficiente)  -> manda el teléfono de recepción
//   sin_respuesta                      -> silencio (acuses, spam)
//   incierto / confianza baja          -> pregunta aclaratoria (máx. MAX_CLARIFY),
//                                         después manda a recepción
//
// Siempre deja registro en franquicia_unmatched. Ante cualquier fallo: false
// y no se envía nada.
async function classifyUnmatched(message, { phone, pushName, text }) {
  const type = message.type || '';
  if (IGNORED_TYPES.includes(type)) return false;

  const isReply = Boolean(message.context?.id);
  let verdict = null;
  let action;
  let botReply = null;

  if (!aiConfig.enabled) {
    action = 'ai_off';
  } else if (!text.trim() && !message.referral) {
    action = 'no_text'; // audio, sticker, imagen sin pie: no hay nada que leer
  } else {
    const triage = await loadTriage(phone);
    verdict = await classifyLead({
      text, type, isReply, referral: message.referral || null, history: triage.history,
    });

    const sure = verdict && verdict.confidence >= aiConfig.minConfidence;
    // Ya se le mandó a recepción hace poco: no insistir con más mensajes.
    const coolingDown = triage.status === 'redirected';

    if (!verdict) action = 'ai_error';
    else if (verdict.intent === 'franquicia' && sure) action = 'started';
    else if (coolingDown) action = 'skipped';
    else if (verdict.intent === 'sin_respuesta' && sure) action = 'skipped';
    // Responde/cita un mensaje nuestro (recordatorio de clase) y no es claro que
    // busque la franquicia: no se le pregunta nada. Solo se canaliza si pide algo.
    // (No aplica si está contestando nuestra pregunta aclaratoria.)
    else if (isReply && triage.status !== 'asking' && !(verdict.intent === 'atencion' && sure)) action = 'skipped';
    else if (verdict.intent === 'atencion' && sure) action = 'redirected';
    else if (!config.triageReplies) action = 'skipped';
    else if (triage.turns < MAX_CLARIFY) action = 'asked';
    else action = 'redirected'; // ya se preguntó y sigue sin quedar claro

    if (action === 'redirected' && !config.triageReplies) action = 'skipped';

    if (action === 'asked' || action === 'redirected') {
      const saludo = firstName(pushName);
      botReply = action === 'asked'
        ? (verdict.question || CLARIFY_FALLBACK({ saludo }))
        : SUPPORT_REDIRECT({ saludo, supportPhone: config.supportPhone });

      // Reserva atómica: si llegan dos mensajes seguidos, solo uno recibe respuesta.
      if (!(await reserveTriageReply(phone))) {
        action = 'skipped';
        botReply = null;
      } else {
        const result = await sendText(phone, botReply, false);
        if (!result.ok) {
          console.warn(`[franq][triage] no se pudo responder a ${phone}: ${result.error}`);
          action = 'send_error';
        }
      }
    }

    if (action === 'asked' || action === 'redirected' || action === 'started') {
      await saveTriage(phone, { triage, action, text, botReply })
        .catch((err) => console.error('[franq][triage] no se pudo guardar el estado', err));
    }
  }

  await sql`
    INSERT INTO franquicia_unmatched
      (message_id, phone, push_name, msg_type, text, is_reply, has_referral, ai_intent, ai_confidence, ai_reason, action, bot_reply)
    VALUES
      (${message.id || null}, ${phone}, ${pushName}, ${type}, ${text.slice(0, 500)}, ${isReply}, ${Boolean(message.referral)},
       ${verdict?.intent ?? null}, ${verdict?.confidence ?? null}, ${verdict?.reason ?? null}, ${action}, ${botReply})`
    .catch((err) => console.error('[franq] no se pudo registrar mensaje no disparado', err));

  if (verdict) {
    console.log(`[franq][ai] ${phone} -> ${verdict.intent} (${verdict.confidence.toFixed(2)}) ${action}`);
  }
  return action === 'started';
}

/* --------------------- estado de la conversación de triage --------------------- */

const MAX_CLARIFY = 2;                 // preguntas aclaratorias antes de mandar a recepción
const TRIAGE_RESET_MS = 24 * 3600e3;   // pasado este tiempo la conversación empieza de cero

async function loadTriage(phone) {
  const [row] = await sql`SELECT * FROM franquicia_triage WHERE phone = ${phone}`;
  const fresh = row && Date.now() - new Date(row.updated_at).getTime() < TRIAGE_RESET_MS;
  if (!fresh) return { turns: 0, status: 'new', history: [] };
  return { turns: row.turns || 0, status: row.status, history: Array.isArray(row.history) ? row.history : [] };
}

// true si este proceso puede responder; false si otro respondió hace unos segundos.
async function reserveTriageReply(phone) {
  const rows = await sql`
    INSERT INTO franquicia_triage (phone, last_reply_at) VALUES (${phone}, now())
    ON CONFLICT (phone) DO UPDATE SET last_reply_at = now()
      WHERE franquicia_triage.last_reply_at IS NULL
         OR franquicia_triage.last_reply_at < now() - interval '15 seconds'
    RETURNING phone`;
  return rows.length > 0;
}

async function saveTriage(phone, { triage, action, text, botReply }) {
  const history = [...triage.history, { role: 'user', text: text.slice(0, 500) }];
  if (botReply && action === 'asked') history.push({ role: 'bot', text: botReply });
  const turns = triage.turns + (action === 'asked' ? 1 : 0);
  const status = action === 'asked' ? 'asking' : action; // asking | redirected | started
  await sql`
    INSERT INTO franquicia_triage (phone, turns, status, history, updated_at)
    VALUES (${phone}, ${turns}, ${status}, ${JSON.stringify(history.slice(-8))}::jsonb, now())
    ON CONFLICT (phone) DO UPDATE
      SET turns = EXCLUDED.turns, status = EXCLUDED.status, history = EXCLUDED.history, updated_at = now()`;
}

// Últimos mensajes que no dispararon por regla fija (para revisar / rescatar a mano).
export async function getUnmatched(limit = 50) {
  await ensureSchema();
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return sql`
    SELECT created_at, phone, push_name, msg_type, text, is_reply, has_referral,
           ai_intent, ai_confidence, ai_reason, action, bot_reply
    FROM franquicia_unmatched
    ORDER BY created_at DESC
    LIMIT ${n}`;
}

/* ---------------------------- 2) cron externo --------------------------- */

export async function processDueLeads() {
  // Con FRANQ_ENABLED=false tampoco salen seguimientos a leads que ya estaban en el flujo
  if (!config.enabled) return { revisados: 0, enviados: 0, expirados: 0, pausado: true };
  await ensureSchema();
  const now = new Date();

  // Reserva atómica: dos ejecuciones simultáneas del cron nunca toman el mismo lead
  const due = await sql`
    UPDATE franquicia_leads SET locked_until = now() + interval '2 minutes'
    WHERE phone IN (
      SELECT phone FROM franquicia_leads
      WHERE status = 'active' AND next_at <= now()
        AND (locked_until IS NULL OR locked_until <= now())
      ORDER BY next_at
      LIMIT ${CRON_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *`;

  let sent = 0, expired = 0;
  const last = MESSAGES.length - 1;

  for (const lead of due) {
    const windowEnd = new Date(lead.last_inbound_at).getTime() + WINDOW_MS - WINDOW_SAFETY_MS;
    if (now.getTime() >= windowEnd) {
      await sql`
        UPDATE franquicia_leads SET status = 'expired', next_at = NULL, locked_until = NULL, updated_at = now()
        WHERE phone = ${lead.phone}`;
      expired++;
      continue;
    }

    // Si el cron se atrasó y ya toca el último mensaje, saltar directo a él
    let stepIndex = lead.step;
    if (stepIndex > 0 && stepIndex < last
        && now.getTime() >= new Date(lead.started_at).getTime() + config.offsetsMs[last]) {
      stepIndex = last;
    }

    await sendStep(lead, stepIndex);
    sent++;
  }

  // Limpieza de ids viejos (no bloquea si falla)
  await sql`DELETE FROM franquicia_inbound WHERE created_at < now() - interval '7 days'`.catch(() => {});
  await sql`DELETE FROM franquicia_unmatched WHERE created_at < now() - interval '60 days'`.catch(() => {});
  await sql`DELETE FROM franquicia_triage WHERE updated_at < now() - interval '7 days'`.catch(() => {});

  return { revisados: due.length, enviados: sent, expirados: expired };
}

export async function getStats() {
  await ensureSchema();
  const byStatus = await sql`SELECT status, count(*)::int AS total FROM franquicia_leads GROUP BY status ORDER BY status`;
  const byStep = await sql`SELECT step AS mensajes_enviados, count(*)::int AS total FROM franquicia_leads GROUP BY step ORDER BY step`;
  const [{ desde_anuncio }] = await sql`SELECT count(*)::int AS desde_anuncio FROM franquicia_leads WHERE referral IS NOT NULL`;
  const [{ hoy }] = await sql`SELECT count(*)::int AS hoy FROM franquicia_leads WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'America/Mexico_City') AT TIME ZONE 'America/Mexico_City'`;
  const bySource = await sql`SELECT COALESCE(trigger_source, 'previo') AS origen, count(*)::int AS total FROM franquicia_leads GROUP BY 1 ORDER BY 1`;
  const unmatched = await sql`SELECT action AS accion, count(*)::int AS total FROM franquicia_unmatched WHERE created_at >= now() - interval '7 days' GROUP BY action ORDER BY action`;
  return {
    porEstado: byStatus, porPaso: byStep, desdeAnuncio: desde_anuncio, nuevosHoy: hoy,
    porOrigen: bySource,
    noDisparados7d: unmatched,
    claude: { activo: aiConfig.enabled, modelo: aiConfig.model, confianzaMinima: aiConfig.minConfidence, responde: config.triageReplies, recepcion: config.supportPhone },
  };
}

/* ------------------------------- envío ---------------------------------- */

async function sendStep(lead, stepIndex) {
  const body = MESSAGES[stepIndex]({
    saludo: firstName(lead.push_name),
    community: config.community,
    landing: config.landing,
  });

  const result = await sendText(lead.phone, body, true);
  const now = new Date();
  const entry = JSON.stringify([{ step: stepIndex + 1, at: iso(now), ok: result.ok, error: result.error || null }]);

  if (result.ok) {
    const sentCount = stepIndex + 1;
    const done = sentCount >= MESSAGES.length;
    let nextAt = null;
    if (!done) {
      const scheduled = new Date(lead.started_at).getTime() + config.offsetsMs[sentCount];
      nextAt = new Date(Math.max(scheduled, now.getTime() + (stepIndex === 0 ? 0 : MIN_GAP_MS)));
    }
    await sql`
      UPDATE franquicia_leads
      SET step = ${sentCount}, attempts = 0, next_at = ${nextAt ? iso(nextAt) : null},
          locked_until = NULL, status = ${done ? 'completed' : 'active'},
          history = history || ${entry}::jsonb, updated_at = now()
      WHERE phone = ${lead.phone}`;
    console.log(`[franq] mensaje ${sentCount}/${MESSAGES.length} -> ${lead.phone}`);
    return;
  }

  const attempts = (lead.attempts || 0) + 1;
  const windowClosed = result.code === 131047; // ventana de 24 h cerrada
  const giveUp = windowClosed || attempts >= MAX_ATTEMPTS;
  const status = giveUp ? (windowClosed ? 'expired' : 'failed') : 'active';
  const nextAt = giveUp ? null : iso(new Date(now.getTime() + RETRY_DELAY_MS));
  await sql`
    UPDATE franquicia_leads
    SET attempts = ${attempts}, locked_until = NULL, next_at = ${nextAt}, status = ${status},
        history = history || ${entry}::jsonb, updated_at = now()
    WHERE phone = ${lead.phone}`;
  console.warn(`[franq] falló mensaje ${stepIndex + 1} -> ${lead.phone} (intento ${attempts}): ${result.error}`);
}

async function sendText(to, body, previewUrl) {
  const url = `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body, preview_url: previewUrl },
        biz_opaque_callback_data: CALLBACK_TAG,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => ({}));
    const e = data.error || {};
    return { ok: false, code: e.code, error: `${res.status} ${e.code ?? ''}: ${e.message || 'error'}`.slice(0, 300) };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 300) };
  }
}

/* ------------------------------ utilidades ------------------------------ */

const iso = (d) => d.toISOString();

export function normalize(str = '') {
  return String(str).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

export function extractText(message) {
  return message.text?.body
    || message.button?.text
    || message.interactive?.button_reply?.title
    || message.interactive?.list_reply?.title
    || message.image?.caption
    || message.video?.caption
    || '';
}

// Devuelve qué regla disparó ('referral' | 'keyword') o '' si ninguna.
export function shouldTrigger(normText, referral) {
  if (config.referralTriggers && referral) {
    if (!config.adIds.length || config.adIds.includes(String(referral.source_id))) return 'referral';
  }
  return config.keywords.some((k) => normText.includes(k)) ? 'keyword' : '';
}

export function firstName(pushName = '') {
  const first = String(pushName).trim().split(/\s+/)[0] || '';
  if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2,20}$/.test(first)) return '';
  return ' ' + first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

// true si TODOS los estados del payload son de mensajes del flujo
export function isFranquiciasStatusOnly(payload) {
  let found = false;
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      if ((value.messages || []).length) return false;
      for (const st of value.statuses || []) {
        if (st.biz_opaque_callback_data !== CALLBACK_TAG) return false;
        found = true;
      }
    }
  }
  return found;
}
