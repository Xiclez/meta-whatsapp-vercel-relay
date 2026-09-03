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
│   └── meta-webhook.js
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
