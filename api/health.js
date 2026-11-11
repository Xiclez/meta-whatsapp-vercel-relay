import { aiConfig, aiOffReason } from "../lib/franquicias/classifier.js";

export default {
  fetch() {
    return Response.json(
      {
        ok: true,
        service: "meta-whatsapp-vercel-relay",
        runtime: process.version,
        // Diagnóstico del respaldo con Claude (no expone la API key).
        claude: aiConfig.enabled
          ? { activo: true, modelo: aiConfig.model }
          : { activo: false, motivo: aiOffReason() },
        timestamp: new Date().toISOString()
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store"
        }
      }
    );
  }
};
