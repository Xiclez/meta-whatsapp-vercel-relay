// api/franquicias-cron.js
// Lo llama un cron externo (cron-job.org) cada 5 minutos.
//
//   GET /cron/franquicias          -> envía los mensajes programados que ya tocan
//   GET /cron/franquicias?stats=1  -> estadísticas del flujo
//
// Autorización: header "Authorization: Bearer <CRON_SECRET>"  (o ?secret=<CRON_SECRET>)

import crypto from 'node:crypto';
import { processDueLeads, getStats } from '../lib/franquicias/flow.js';

const json = (body, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

function authorized(request, url) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get('authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('secret') || '';
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (!['GET', 'POST'].includes(request.method)) {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } });
    }
    if (!authorized(request, url)) {
      return json({ ok: false, error: 'Unauthorized' }, 401);
    }

    try {
      if (url.searchParams.get('stats')) {
        return json({ ok: true, ...(await getStats()) });
      }
      const result = await processDueLeads();
      if (result.revisados) console.log('[franq] cron', result);
      return json({ ok: true, ...result });
    } catch (err) {
      console.error('[franq] cron error', err);
      return json({ ok: false, error: String(err?.message || err) }, 500);
    }
  },
};
