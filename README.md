# Meta WhatsApp -> Vercel -> Google Apps Script

Servidor relay mínimo para:

1. Validar el webhook de Meta for Developers.
2. Recibir eventos de WhatsApp Cloud API.
3. Validar `x-hub-signature-256` usando tu Meta App Secret.
4. Reenviar el payload a Google Apps Script.

No usa Express, Docker ni servidor persistente. Está adaptado a Vercel Functions usando `Request` / `Response`.

---

## Estructura

```text
meta-whatsapp-vercel-relay/
├── api/
│   ├── health.js
│   ├── meta-webhook.js
│   ├── stripe-webhook.js
│   └── franquicias-cron.js     ← cron del flujo Franquicias
├── lib/
│   └── franquicias/
│       ├── flow.js             ← lógica del flujo (Neon)
│       └── messages.js         ← textos de los 4 mensajes
├── apps-script/
│   └── doPost.gs
├── .env.example
├── .gitignore
├── package.json
├── vercel.json
└── README.md
```

---

# 1. Configurar Apps Script

Agrega el contenido de:

```text
apps-script/doPost.gs
```

a tu proyecto de Apps Script.

En:

```text
Project Settings
→ Script Properties
```

crea:

```text
META_RELAY_SECRET
```

con un secreto largo.

Después:

```text
Deploy
→ New deployment
→ Web app
```

Configura:

```text
Execute as: Me
Who has access: Anyone
```

Copia la URL terminada en:

```text
/exec
```

Ejemplo:

```text
https://script.google.com/macros/s/AKfycbXXXXXXXXXXXX/exec
```

---

# 2. Crear proyecto en Vercel

Puedes subir esta carpeta a GitHub e importarla desde Vercel.

También puedes desplegar desde terminal:

```bash
npx vercel
```

Producción:

```bash
npx vercel --prod
```

El proyecto usa Node.js 24.x.

---

# 3. Variables de entorno en Vercel

Ve a:

```text
Project
→ Settings
→ Environment Variables
```

Crea:

```text
META_VERIFY_TOKEN
META_APP_SECRET
APPS_SCRIPT_URL
APPS_SCRIPT_SECRET
APPS_SCRIPT_TIMEOUT_MS
```

### META_VERIFY_TOKEN

Lo eliges tú.

Ejemplo:

```text
ULAL_META_WEBHOOK_2026_xxxxx
```

Será exactamente el mismo que escribirás en Meta como Verify token.

### META_APP_SECRET

Obtén el App Secret desde Meta for Developers.

### APPS_SCRIPT_URL

La URL `/exec` del Web App.

### APPS_SCRIPT_SECRET

Debe ser exactamente igual a:

```text
META_RELAY_SECRET
```

en Apps Script.

### APPS_SCRIPT_TIMEOUT_MS

Opcional.

Recomendado:

```text
8000
```

---

# 4. Endpoints

Health:

```text
GET /
GET /health
```

Webhook:

```text
GET  /webhook/meta
POST /webhook/meta
```

Ejemplo:

```text
https://tu-proyecto.vercel.app/webhook/meta
```

---

# 5. Probar el servidor

Abre:

```text
https://tu-proyecto.vercel.app/
```

Debe devolver JSON similar a:

```json
{
  "ok": true,
  "service": "meta-whatsapp-vercel-relay",
  "runtime": "v24.x.x",
  "timestamp": "..."
}
```

---

# 6. Probar manualmente la validación de Meta

```bash
curl "https://tu-proyecto.vercel.app/webhook/meta?hub.mode=subscribe&hub.verify_token=TU_VERIFY_TOKEN&hub.challenge=123456"
```

Debe responder exactamente:

```text
123456
```

---

# 7. Configurar Meta for Developers

En la configuración de Webhooks de WhatsApp:

Callback URL:

```text
https://tu-proyecto.vercel.app/webhook/meta
```

Verify token:

```text
mismo valor de META_VERIFY_TOKEN
```

Pulsa:

```text
Verify and save
```

---

# 8. Flujo final

```text
Google Calendar
      │
      ▼
Apps Script
      │
      ▼
WhatsApp Cloud API / Meta
      │
      ├─────────────┐
      ▼             ▼
   Alumno         Maestro


Respuestas / estados
      │
      ▼
     Meta
      │ webhook
      ▼
    Vercel
      │
      ├─ valida firma Meta
      │
      ▼
 Apps Script
```

---

# 9. Seguridad

No subas valores reales de:

```text
META_APP_SECRET
APPS_SCRIPT_SECRET
```

al repositorio.

El POST de Meta se valida usando:

```text
x-hub-signature-256
```

El relay Vercel -> Apps Script se protege con:

```text
APPS_SCRIPT_SECRET
```

Apps Script recibe ese valor dentro del JSON y lo compara con:

```text
META_RELAY_SECRET
```

---

# 10. Nota sobre reintentos

Si Apps Script no responde correctamente, el relay responde HTTP 500 a Meta para permitir reintentos.

Cuando empieces a ejecutar acciones sobre mensajes entrantes, debes hacerlas idempotentes usando IDs de mensajes/eventos para que un reintento no duplique acciones.


---

# 11. Flujo Franquicias (anuncios Click-to-WhatsApp)

Cuando alguien escribe desde el anuncio de Meta, el bot responde automáticamente:

| # | Cuándo | Contenido |
|---|--------|-----------|
| 1 | Inmediato | Únete a la comunidad + enlace |
| 2 | +6 h | Infórmate más + landing |
| 3 | +12 h | ¿Ya te uniste? + enlace |
| 4 | +23 h | Último mensaje + enlace |

Todo va como texto libre dentro de la ventana de 24 h (no requiere plantillas).

### Cómo convive con lo demás

- Corre dentro de `api/meta-webhook.js` en segundo plano (`waitUntil`). **El reenvío a Apps Script sigue igual** y un error del flujo nunca afecta la respuesta a Meta.
- Solo entra al flujo quien escribe *"escuela digital"* o *"franquicia"*, o quien llega desde un anuncio (Meta incluye `referral`). Alumnos y maestros que responden recordatorios **no** entran.
- BAJA / STOP / ALTO / CANCELAR solo se atiende si el número es un lead del flujo.
- Idempotente por `message.id`: si Meta reintenta (p. ej. porque Apps Script falló), no se duplican mensajes.
- Los estados (sent/delivered/read) de los mensajes del flujo **no** se reenvían a Apps Script, para no gastar su cuota. Se identifican con `biz_opaque_callback_data = "franq_flow"`.
- Tablas en Neon (se crean solas): `franquicia_leads`, `franquicia_inbound`.

### Variables de entorno

Reutiliza las que ya existen: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_GRAPH_VERSION`, `DATABASE_URL`.

Nueva, **obligatoria**:

```text
CRON_SECRET          texto largo aleatorio (el mismo va en cron-job.org)
```

Opcionales (tienen valor por defecto):

```text
FRANQ_PHONE_NUMBER_ID     si el flujo corre en un número distinto a WHATSAPP_PHONE_NUMBER_ID
FRANQ_COMMUNITY_LINK      https://chat.whatsapp.com/IUeFFiRZ8zrJWGsajKDqri
FRANQ_LANDING_URL         https://franquicias.ulalmexico.com
FRANQ_FOLLOWUP_HOURS      6,12,23   (el último debe ser < 24)
FRANQ_KEYWORDS            escuela digital,franquicia
FRANQ_REFERRAL_TRIGGERS   true      (iniciar si viene de cualquier anuncio CTWA)
FRANQ_AD_IDS              vacío     (si lo llenas, solo esos IDs de anuncio disparan el flujo)
FRANQ_RESTART_AFTER_DAYS  7
FRANQ_ENABLED             true      (false = pausa todo: no entran leads nuevos ni salen seguimientos)
```

Generar `CRON_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

### Cron externo (cron-job.org)

1. Crea una cuenta gratis en https://cron-job.org → **Create cronjob**.
2. URL: `https://tu-proyecto.vercel.app/cron/franquicias`
3. Ejecución: **cada 5 minutos**.
4. **Advanced → Headers**: `Authorization` = `Bearer TU_CRON_SECRET`
5. **Test run** → debe responder `{"ok":true,"revisados":0,...}`. Si da `401`, el secreto no coincide.
6. Activa la notificación por correo cuando falle.

Estadísticas:

```text
GET /cron/franquicias?stats=1     (con el mismo header)
```

### Respaldo con Claude (clasificador de leads)

Cuando un contacto **nuevo** escribe y ni la frase ni el anuncio disparan el flujo, el mensaje se le pasa a Claude (`lib/franquicias/classifier.js`), que lo clasifica como `franquicia`, `alumno_maestro` u `otro`. Si es `franquicia` con confianza suficiente, arranca el flujo normal.

- Las reglas fijas siguen siendo la vía rápida: si disparan, no se llama a Claude.
- Si Claude falla, tarda más de 8 s o no hay API key, no se envía nada (igual que antes).
- Audios, stickers e imágenes sin texto no se clasifican; solo se registran.
- Todo mensaje que pasa por aquí queda en la tabla `franquicia_unmatched` (se crea sola, se limpia a los 60 días) con el veredicto y lo que se hizo: `started`, `skipped`, `ai_off`, `ai_error`, `no_text`.

Variables:

```text
ANTHROPIC_API_KEY         obligatoria para activar el respaldo (https://console.anthropic.com)
FRANQ_AI_ENABLED          true      (false = apaga solo el respaldo con Claude)
FRANQ_AI_MODEL            claude-haiku-5-5
FRANQ_AI_MIN_CONFIDENCE   0.7       (súbelo si le llega el enlace a alumnos; bájalo si se escapan leads)
```

Revisar qué se quedó fuera (para rescatar leads a mano dentro de las 24 h):

```text
GET /cron/franquicias?unmatched=1&limit=50     (con el mismo header)
```

`?stats=1` ahora incluye `porOrigen` (keyword / referral / ai) y `noDisparados7d`.

### Editar los textos

`lib/franquicias/messages.js`. Formato WhatsApp: `*negritas*`, `_cursivas_`.
