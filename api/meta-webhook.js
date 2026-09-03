import crypto from "node:crypto";

/**
 * Meta WhatsApp Cloud API webhook relay.
 *
 * Endpoints:
 *   GET  /webhook/meta  -> validación inicial de Meta
 *   POST /webhook/meta  -> eventos de WhatsApp
 *
 * Vercel ejecuta este archivo como Vercel Function.
 * Usamos Request/Response Web APIs para conservar el body RAW y validar
 * correctamente x-hub-signature-256.
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET") {
      return handleMetaVerification(url);
    }

    if (request.method === "POST") {
      return handleMetaWebhook(request);
    }

    return new Response("Method Not Allowed", {
      status: 405,
      headers: {
        Allow: "GET, POST",
        "Cache-Control": "no-store"
      }
    });
  }
};


// ============================================================================
// 1. VALIDACIÓN INICIAL DEL WEBHOOK
// ============================================================================

function handleMetaVerification(url) {
  const verifyToken = process.env.META_VERIFY_TOKEN;

  if (!verifyToken) {
    console.error("META_VERIFY_TOKEN no está configurado.");

    return new Response("Server misconfigured", {
      status: 500
    });
  }

  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (
    mode === "subscribe" &&
    token === verifyToken &&
    challenge
  ) {
    console.log("✅ Webhook de Meta validado.");

    // Meta exige que devolvamos literalmente hub.challenge.
    return new Response(challenge, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }

  console.warn("❌ Intento de validación rechazado.", {
    mode,
    tokenMatches: token === verifyToken,
    hasChallenge: Boolean(challenge)
  });

  return new Response("Forbidden", {
    status: 403
  });
}


// ============================================================================
// 2. RECEPCIÓN DE EVENTOS DE META
// ============================================================================

async function handleMetaWebhook(request) {
  const appSecret = process.env.META_APP_SECRET;

  if (!appSecret) {
    console.error("META_APP_SECRET no está configurado.");

    return new Response("Server misconfigured", {
      status: 500
    });
  }

  /**
   * IMPORTANTE:
   * No usamos request.json() antes de validar la firma.
   * Meta firma el cuerpo original; necesitamos exactamente ese contenido.
   */
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!verifyMetaSignature(rawBody, signature, appSecret)) {
    console.warn("❌ Webhook rechazado: firma de Meta inválida.");

    return new Response("Unauthorized", {
      status: 401
    });
  }

  let metaPayload;

  try {
    metaPayload = JSON.parse(rawBody);
  } catch (error) {
    console.error("JSON inválido recibido de Meta.", error);

    return new Response("Invalid JSON", {
      status: 400
    });
  }

  /**
   * La app podría recibir otros objetos de Meta.
   * Solo reenviamos webhooks de WhatsApp Business.
   */
  if (metaPayload?.object !== "whatsapp_business_account") {
    console.log("⏭️ Payload ignorado: no es WhatsApp Business.");

    return new Response("EVENT_RECEIVED", {
      status: 200,
      headers: {
        "Cache-Control": "no-store"
      }
    });
  }

  try {
    await forwardToAppsScript(metaPayload);

    console.log("✅ Evento de Meta reenviado a Apps Script.");

    return new Response("EVENT_RECEIVED", {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });

  } catch (error) {
    /**
     * Devolvemos 500 si Apps Script no pudo recibirlo.
     * Así Meta puede reintentar la entrega.
     *
     * Cuando empieces a ejecutar acciones sobre mensajes entrantes,
     * implementa idempotencia usando message.id / status.id para que un
     * retry nunca duplique una acción.
     */
    console.error("🔥 No se pudo reenviar a Apps Script:", error);

    return new Response("Relay failed", {
      status: 500,
      headers: {
        "Cache-Control": "no-store"
      }
    });
  }
}


// ============================================================================
// 3. FIRMA DE META: x-hub-signature-256
// ============================================================================

function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
  if (
    !signatureHeader ||
    !signatureHeader.startsWith("sha256=")
  ) {
    return false;
  }

  const expectedSignature =
    "sha256=" +
    crypto
      .createHmac("sha256", appSecret)
      .update(rawBody, "utf8")
      .digest("hex");

  const received = Buffer.from(signatureHeader, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");

  if (received.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(received, expected);
}


// ============================================================================
// 4. VERCEL -> APPS SCRIPT
// ============================================================================

async function forwardToAppsScript(metaPayload) {
  const appsScriptUrl = process.env.APPS_SCRIPT_URL;
  const relaySecret = process.env.APPS_SCRIPT_SECRET;

  if (!appsScriptUrl) {
    throw new Error("APPS_SCRIPT_URL no está configurado.");
  }

  if (!relaySecret) {
    throw new Error("APPS_SCRIPT_SECRET no está configurado.");
  }

  const timeoutMs = getTimeoutMs();

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const relayPayload = {
    source: "meta_whatsapp",
    relaySecret,
    receivedAt: new Date().toISOString(),
    payload: metaPayload
  };

  try {
    const response = await fetch(appsScriptUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(relayPayload),

      // Apps Script suele redirigir /exec a googleusercontent.
      redirect: "follow",

      signal: controller.signal
    });

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(
        `Apps Script HTTP ${response.status}: ${responseText.slice(0, 500)}`
      );
    }

    /**
     * ContentService normalmente devuelve HTTP 200 aunque nuestra lógica
     * devuelva { ok:false }. Si la respuesta es JSON, también validamos eso.
     */
    let parsed = null;

    try {
      parsed = JSON.parse(responseText);
    } catch (_) {
      // Permitimos respuesta no JSON mientras HTTP haya sido 2xx.
    }

    if (parsed && parsed.ok === false) {
      throw new Error(
        `Apps Script rechazó el evento: ${parsed.error || "unknown error"}`
      );
    }

    return true;

  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(
        `Timeout esperando Apps Script después de ${timeoutMs} ms.`
      );
    }

    throw error;

  } finally {
    clearTimeout(timeout);
  }
}


function getTimeoutMs() {
  const configured = Number(
    process.env.APPS_SCRIPT_TIMEOUT_MS || 8000
  );

  if (!Number.isFinite(configured)) {
    return 8000;
  }

  return Math.min(
    Math.max(configured, 1000),
    20000
  );
}
