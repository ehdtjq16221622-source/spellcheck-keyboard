// Manual grants stay closed until an authenticated, idempotent admin flow is ready.
const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve((_req) =>
  new Response(JSON.stringify({ error: 'Manual credit grants are disabled.' }), {
    status: 403,
    headers,
  })
)

