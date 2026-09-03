export default {
  fetch() {
    return Response.json(
      {
        ok: true,
        service: "meta-whatsapp-vercel-relay",
        runtime: process.version,
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
