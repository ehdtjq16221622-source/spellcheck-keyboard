// DEPRECATED. Replaced by admob_ssv_callback (Server-Side Verification).
// The previous client-driven flow was bypassable: any caller could POST a
// fresh UUID as rewardEventId and earn credits without watching an ad.
// Kept here returning 410 Gone so legacy clients fail loudly rather than
// silently succeeding against a stale code path.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve((req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  return new Response(
    JSON.stringify({
      error: 'This endpoint is no longer available. Please update to the latest app version.',
    }),
    {
      status: 410,
      headers: { ...cors, 'Content-Type': 'application/json' },
    }
  )
})
