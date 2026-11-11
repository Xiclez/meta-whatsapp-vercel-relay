// =====================================================================
// MENSAJES DEL FLUJO "FRANQUICIA ULAL"
// ---------------------------------------------------------------------
// Edita aquí los textos. Cada mensaje es una función que recibe:
//   { saludo, community, landing }
//   - saludo:    " Juan" (con espacio) o "" si el nombre no parece válido
//   - community: enlace de la comunidad de WhatsApp
//   - landing:   enlace de la landing page
//
// El orden del arreglo = orden de envío.
// Los tiempos se configuran en FOLLOWUP_HOURS (por defecto 6,12,23).
//
// Formato WhatsApp: *negritas*, _cursivas_, ~tachado~
// =====================================================================

export const MESSAGES = [
    // ---------------------------------------------------------------
    // 1) INMEDIATO — Únete a la comunidad
    // ---------------------------------------------------------------
    ({ saludo, community }) =>
`¡Hola${saludo}! 👋 Gracias por tu interés en la *Franquicia Educativa ULAL*.

Toda la información, las respuestas a tus dudas y los próximos pasos los compartimos en nuestra comunidad de WhatsApp.

👉 *Únete aquí:*
${community}

Es gratis y puedes salir cuando quieras.

_Si no deseas recibir más mensajes, responde BAJA._`,

    // ---------------------------------------------------------------
    // 2) +6 HORAS — Infórmate más (landing)
    // ---------------------------------------------------------------
    ({ landing, community }) =>
`📚 *¿Quieres conocer el modelo a detalle?*

Aquí tienes toda la información de la Franquicia Educativa ULAL: cómo funciona, qué incluye, la garantía *Cero Riesgo* y testimonios de nuestros egresados.

👉 ${landing}

¿Te quedó alguna duda? En la comunidad te la resolvemos:
${community}`,

    // ---------------------------------------------------------------
    // 3) +12 HORAS — Únete si no lo has hecho
    // ---------------------------------------------------------------
    ({ saludo, community }) =>
`👋 Hola${saludo}, ¿ya te uniste a la comunidad?

Ahí compartimos los detalles de la franquicia, respondemos preguntas y avisamos primero sobre los *lugares disponibles* para la próxima capacitación.

Si aún no lo has hecho, entra aquí 👇
${community}`,

    // ---------------------------------------------------------------
    // 4) +23 HORAS — Último aviso
    // ---------------------------------------------------------------
    ({ community }) =>
`⏰ *Este es nuestro último mensaje*

Para no saturar tu WhatsApp, a partir de ahora dejarás de recibir mensajes de este número.

Si todavía no te has unido a la comunidad de la Franquicia Educativa ULAL, *este es el momento de hacerlo* 👇
${community}

¡Te esperamos! 🙌`
];

// Respuesta cuando alguien escribe BAJA / STOP / etc.
export const OPT_OUT_REPLY =
`Listo, no volverás a recibir mensajes automáticos de nuestra parte. ✅

Si cambias de opinión, la comunidad sigue abierta para ti.`;

// ---------------------------------------------------------------------
// TRIAGE (contactos nuevos que no dispararon el flujo)
// ---------------------------------------------------------------------

// Cuando el asunto NO es de franquicias (atención al cliente, quejas,
// solicitudes, alumnos, cursos) o no se logró aclarar qué necesita.
export const SUPPORT_REDIRECT = ({ saludo, supportPhone }) =>
`Hola${saludo} 👋 Gracias por escribir a *ULAL*.

Por este medio no podemos darle seguimiento a tu solicitud. Para atención al cliente, quejas, trámites o cualquier otra duda, comunícate con *Recepción*:

📞 ${supportPhone}

Con gusto te atenderán ahí.`;

// Pregunta aclaratoria de respaldo (si la que redacta Claude no es utilizable).
export const CLARIFY_FALLBACK = ({ saludo }) =>
`¡Hola${saludo}! 👋 Gracias por escribir a *ULAL*. ¿Sobre qué te gustaría recibir información: la *Franquicia Educativa ULAL* (abrir tu propia escuela) o algún otro asunto?`;

