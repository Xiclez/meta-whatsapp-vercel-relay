/**
 * RECEPTOR META -> VERCEL -> APPS SCRIPT
 *
 * Este archivo se agrega al MISMO proyecto de Apps Script donde después
 * procesarás respuestas, estados y botones de WhatsApp.
 *
 * CONFIGURACIÓN:
 *
 * Apps Script -> Project Settings -> Script Properties
 *
 * META_RELAY_SECRET = mismo valor de APPS_SCRIPT_SECRET en Vercel
 *
 * Después:
 * Deploy -> New deployment -> Web app
 * Execute as: Me
 * Who has access: Anyone
 *
 * Usa la URL terminada en /exec como APPS_SCRIPT_URL en Vercel.
 */


function doPost(e) {
  try {
    const expectedSecret = PropertiesService
      .getScriptProperties()
      .getProperty("META_RELAY_SECRET");

    if (!expectedSecret) {
      return jsonResponse_({
        ok: false,
        error: "META_RELAY_SECRET no está configurado."
      });
    }


    if (
      !e ||
      !e.postData ||
      !e.postData.contents
    ) {
      return jsonResponse_({
        ok: false,
        error: "Body vacío."
      });
    }


    const relay = JSON.parse(
      e.postData.contents
    );


    // ========================================================================
    // VALIDAR VERCEL -> APPS SCRIPT
    // ========================================================================

    if (
      !relay.relaySecret ||
      relay.relaySecret !== expectedSecret
    ) {
      return jsonResponse_({
        ok: false,
        error: "Unauthorized"
      });
    }


    if (relay.source !== "meta_whatsapp") {
      return jsonResponse_({
        ok: false,
        error: "Fuente desconocida."
      });
    }


    const metaPayload = relay.payload;

    if (
      !metaPayload ||
      metaPayload.object !== "whatsapp_business_account"
    ) {
      return jsonResponse_({
        ok: false,
        error: "Payload de WhatsApp inválido."
      });
    }


    // ========================================================================
    // LOG
    // ========================================================================

    console.log(
      "📩 Webhook de Meta recibido vía Vercel:\n" +
      JSON.stringify(metaPayload, null, 2)
    );


    // ========================================================================
    // RUTEO
    //
    // De momento registramos todos los eventos.
    // Posteriormente puedes activar processMetaWhatsAppPayload_().
    // ========================================================================

    processMetaWhatsAppPayload_(metaPayload);


    return jsonResponse_({
      ok: true,
      received: true
    });


  } catch (error) {
    console.error(
      "❌ Error en doPost:",
      error
    );

    return jsonResponse_({
      ok: false,
      error: String(error)
    });
  }
}


// ============================================================================
// PROCESAMIENTO BÁSICO DE WHATSAPP
// ============================================================================

function processMetaWhatsAppPayload_(payload) {
  const entries = payload.entry || [];

  entries.forEach(function(entry) {
    const changes = entry.changes || [];

    changes.forEach(function(change) {
      if (change.field !== "messages") {
        return;
      }

      const value = change.value || {};


      // ----------------------------------------------------------------------
      // MENSAJES ENTRANTES
      // ----------------------------------------------------------------------

      const messages = value.messages || [];

      messages.forEach(function(message) {
        console.log(
          "💬 Mensaje entrante:",
          JSON.stringify(message)
        );

        handleIncomingWhatsAppMessage_(
          message,
          value
        );
      });


      // ----------------------------------------------------------------------
      // ESTADOS DE MENSAJES SALIENTES
      // sent / delivered / read / failed
      // ----------------------------------------------------------------------

      const statuses = value.statuses || [];

      statuses.forEach(function(status) {
        console.log(
          "📊 Estado WhatsApp:",
          JSON.stringify(status)
        );

        handleWhatsAppStatus_(
          status,
          value
        );
      });
    });
  });
}


// ============================================================================
// HANDLERS
// ============================================================================

function handleIncomingWhatsAppMessage_(message, context) {
  /**
   * Aquí puedes rutear:
   *
   * message.type === "text"
   * message.type === "interactive"
   * message.type === "button"
   * etc.
   *
   * Por ahora solo log.
   */

  console.log(
    "Incoming message ID: " +
    (message.id || "sin-id")
  );
}


function handleWhatsAppStatus_(status, context) {
  /**
   * status.status normalmente puede ser:
   *
   * sent
   * delivered
   * read
   * failed
   *
   * Por ahora solo log.
   */

  console.log(
    "Status " +
    (status.id || "sin-id") +
    ": " +
    (status.status || "unknown")
  );
}


// ============================================================================
// UTILIDAD
// ============================================================================

function jsonResponse_(data) {
  return ContentService
    .createTextOutput(
      JSON.stringify(data)
    )
    .setMimeType(
      ContentService.MimeType.JSON
    );
}
