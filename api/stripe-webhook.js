// api/stripe-webhook.js
// Stripe -> Vercel -> WhatsApp Cloud API   (estado guardado en Neon / Postgres)
//
// Productos rastreados (por ID de producto de Stripe):
//   - Recurrente mensual: envia credenciales al pagar + avisa al admin en CADA cobro fallido.
//   - Pago unico:         envia credenciales al pagar. No genera avisos.
//
// Dependencia: npm i @neondatabase/serverless
// Mismo estilo que api/meta-webhook.js (export default { fetch }).

import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

const TPL_WELCOME = process.env.WA_TEMPLATE_WELCOME || 'ulal_bienvenida_socio';
const TPL_ADMIN = process.env.WA_TEMPLATE_ADMIN || 'ulal_pago_fallido_admin';
const WA_LANG = process.env.WA_TEMPLATE_LANG || 'es_MX';
const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v23.0';

// Acepta uno o varios IDs separados por coma (util para tener test + live)
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const PRODUCTS_RECURRING = list(process.env.STRIPE_PRODUCT_RECURRING);
const PRODUCTS_ONETIME = list(process.env.STRIPE_PRODUCT_ONETIME);

// [{ "username": "socio001", "password": "xxxx" }, ...]
const USERS = JSON.parse(process.env.USERS_JSON || '[]');

/* ------------------------------ base de datos ------------------------------ */

let schemaReady;
function ensureSchema() {
  schemaReady ??= (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS ulal_members (
        identity     TEXT PRIMARY KEY,          -- cus_... o email:... del comprador
        idx          INTEGER NOT NULL UNIQUE,   -- posicion en USERS_JSON
        username     TEXT NOT NULL,
        phone        TEXT,
        email        TEXT,
        customer_id  TEXT,
        kind         TEXT NOT NULL,             -- 'recurring' | 'onetime'
        assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS ulal_events (
        event_id    TEXT PRIMARY KEY,
        status      TEXT NOT NULL,              -- 'processing' | 'done'
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
  })().catch((err) => {
    schemaReady = undefined;
    throw err;
  });
  return schemaReady;
}

async function getMember(identity) {
  const rows = await sql`SELECT * FROM ulal_members WHERE identity = ${identity}`;
  return rows[0] || null;
}

// Asigna el siguiente usuario libre. La restriccion UNIQUE(idx) garantiza que dos pagos
// simultaneos nunca reciban el mismo usuario: el que pierde la carrera reintenta.
async function assignMember({ identity, phone, email, customerId, kind }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [{ next }] = await sql`SELECT COALESCE(MAX(idx) + 1, 0)::int AS next FROM ulal_members`;
    if (next >= USERS.length) {
      // Error -> Stripe reintenta ~3 dias. Agrega usuarios a USERS_JSON y redeploya.
      throw new Error(`Sin usuarios disponibles (${identity})`);
    }
    try {
      const rows = await sql`
        INSERT INTO ulal_members (identity, idx, username, phone, email, customer_id, kind)
        VALUES (${identity}, ${next}, ${USERS[next].username}, ${phone}, ${email}, ${customerId}, ${kind})
        ON CONFLICT (identity) DO NOTHING
        RETURNING *`;
      if (rows.length) return rows[0];
      return await getMember(identity); // otro proceso ya lo asigno a este mismo comprador
    } catch (err) {
      if (err.code !== '23505') throw err; // 23505 = otro pago tomo ese idx; reintentar
    }
  }
  throw new Error(`No se pudo asignar usuario tras varios intentos (${identity})`);
}

async function promoteToRecurring(identity, phone) {
  const rows = await sql`
    UPDATE ulal_members
    SET kind = 'recurring',
        phone = CASE WHEN COALESCE(phone, '') = '' THEN ${phone} ELSE phone END
    WHERE identity = ${identity}
    RETURNING *`;
  return rows[0];
}

// Idempotencia por evento. Devuelve true si este proceso debe atender el evento.
async function acquireEvent(eventId) {
  const rows = await sql`
    INSERT INTO ulal_events (event_id, status) VALUES (${eventId}, 'processing')
    ON CONFLICT (event_id) DO UPDATE SET status = 'processing', created_at = now()
    WHERE ulal_events.status = 'processing'
      AND ulal_events.created_at < now() - interval '5 minutes'
    RETURNING event_id`;
  return rows.length > 0;
}

const markEventDone = (eventId) =>
  sql`UPDATE ulal_events SET status = 'done' WHERE event_id = ${eventId}`;

const releaseEvent = (eventId) =>
  sql`DELETE FROM ulal_events WHERE event_id = ${eventId}`;

/* ---------------------------- utilidades ---------------------------- */

function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  let t = null;
  const v1 = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') t = v;
    if (k === 'v1') v1.push(v);
  }
  if (!t || v1.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;

  const expected = Buffer.from(
    crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  );
  return v1.some((sig) => {
    const b = Buffer.from(sig);
    return b.length === expected.length && crypto.timingSafeEqual(b, expected);
  });
}

// Stripe entrega E.164 (+52614...). WhatsApp quiere solo digitos.
// Si algun numero de MX falla con 52 + 10 digitos, prueba con 521 + 10 digitos.
function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

async function sendTemplate(to, name, params) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name,
        language: { code: WA_LANG },
        components: [
          {
            type: 'body',
            parameters: params.map((text) => ({ type: 'text', text: String(text) })),
          },
        ],
      },
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${await res.text()}`);
}

// El evento del webhook NO trae el producto: hay que pedir los line items a Stripe.
// Devuelve 'recurring' | 'onetime' | null (producto que no nos interesa).
async function getPurchaseKind(sessionId) {
  const res = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${sessionId}/line_items?limit=100`,
    {
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
      signal: AbortSignal.timeout(8000),
    }
  );
  if (!res.ok) throw new Error(`Stripe API ${res.status}: ${await res.text()}`);

  const { data } = await res.json();
  const products = data.map((li) =>
    typeof li.price?.product === 'string' ? li.price.product : li.price?.product?.id
  );

  if (products.some((p) => PRODUCTS_RECURRING.includes(p))) return 'recurring';
  if (products.some((p) => PRODUCTS_ONETIME.includes(p))) return 'onetime';
  return null;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/* --------------------- 1) pago exitoso (ambos) ---------------------- */

async function handleCheckoutPaid(session) {
  if (session.payment_status !== 'paid') return; // OXXO/transferencia: espera async_payment_succeeded

  const kind = await getPurchaseKind(session.id);
  if (!kind) return; // otro producto: ignorar

  const email = session.customer_details?.email || null;
  const phone = normalizePhone(session.customer_details?.phone);

  // Los pagos unicos pueden no crear "customer" en Stripe; en ese caso usamos el correo.
  const identity =
    session.customer ||
    (email ? `email:${email.toLowerCase()}` : `session:${session.id}`);

  let rec = await getMember(identity);

  if (!rec) {
    rec = await assignMember({
      identity,
      phone,
      email,
      customerId: session.customer || null,
      kind,
    });
  } else if (kind === 'recurring' && rec.kind !== 'recurring') {
    // Compro primero el pago unico y luego se suscribe: ahora si recibe avisos de cobro.
    rec = await promoteToRecurring(identity, phone);
  }

  if (!rec.phone) {
    console.error('Pago sin telefono', { identity, email: rec.email, username: rec.username });
    return;
  }

  const user = USERS[rec.idx];
  await sendTemplate(rec.phone, TPL_WELCOME, [user.username, user.password]);
}

/* ---------- 2) cobro fallido (cada intento, solo recurrentes) ------- */

async function handlePaymentFailed(invoice) {
  const rec = await getMember(invoice.customer);
  if (!rec || rec.kind !== 'recurring') return; // no es un socio recurrente nuestro

  await sendTemplate(normalizePhone(process.env.ADMIN_WHATSAPP), TPL_ADMIN, [
    rec.username,
    rec.phone ? `+${rec.phone}` : rec.email || 'sin dato',
  ]);
}

/* ------------------------------ router ------------------------------ */

async function processEvent(event) {
  const obj = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return handleCheckoutPaid(obj);

    case 'invoice.payment_failed':
      return handlePaymentFailed(obj);

    default:
      return;
  }
}

export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'POST', 'Cache-Control': 'no-store' },
      });
    }
    return handleStripeWebhook(request);
  },
};

async function handleStripeWebhook(request) {
  const rawBody = await request.text(); // el body crudo es indispensable para validar la firma

  if (
    !verifyStripeSignature(
      rawBody,
      request.headers.get('stripe-signature'),
      process.env.STRIPE_WEBHOOK_SECRET
    )
  ) {
    return json({ error: 'invalid signature' }, 400);
  }

  const event = JSON.parse(rawBody);

  try {
    await ensureSchema();

    // Un reenvio del MISMO evento no repite el mensaje.
    // (Cada intento de cobro fallido es un evento distinto, asi que cada uno avisa.)
    if (!(await acquireEvent(event.id))) return json({ ok: true, duplicate: true });

    try {
      await processEvent(event);
    } catch (err) {
      await releaseEvent(event.id).catch(() => {});
      throw err;
    }

    await markEventDone(event.id);

    // Limpieza oportunista de eventos viejos (no bloquea la respuesta si falla)
    sql`DELETE FROM ulal_events WHERE created_at < now() - interval '30 days'`.catch(() => {});

    return json({ ok: true });
  } catch (err) {
    console.error('stripe-webhook error', event.type, event.id, err);
    return json({ error: 'processing failed' }, 500); // Stripe reintenta
  }
}
