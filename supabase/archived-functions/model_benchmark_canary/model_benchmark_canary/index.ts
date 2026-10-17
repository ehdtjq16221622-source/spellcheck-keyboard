Deno.serve(() => new Response(
  JSON.stringify({ error: 'BENCHMARK_CLOSED' }),
  { status: 410, headers: { 'Content-Type': 'application/json' } },
))
