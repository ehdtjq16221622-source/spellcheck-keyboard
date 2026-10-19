import { createPipeline as before, sourceSha256 as beforeHash } from './generated-before.ts'
import { createPipeline as after, sourceSha256 as afterHash } from './generated-after.ts'
import { cases } from './cases.ts'

type Control = { enabled?: boolean; starts?: number; expires?: number; token?: string }
type Dependencies = { env: (name: string) => string | undefined; fetch: typeof globalThis.fetch; now: () => number }
export function createHandler(deps: Dependencies = { env: (name) => Deno.env.get(name), fetch: globalThis.fetch, now: Date.now }) {
  const used = new Set<string>() // Per isolate only, not a project-wide spending cap.
  const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
  return async (req: Request): Promise<Response> => {
    let control: Control
    try { control = JSON.parse(deps.env('TONE_COMPLETION_PROBE_CONTROL') ?? '{}') } catch { return reply(410, { error: 'CLOSED' }) }
    const { starts, expires, token } = control
    if (control.enabled !== true || typeof starts !== 'number' || typeof expires !== 'number' ||
        expires <= starts || expires - starts > 10 * 60_000 || deps.now() < starts || deps.now() >= expires ||
        typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return reply(410, { error: 'CLOSED' })
    const supplied = req.headers.get('x-tone-probe-token') ?? ''
    if (!/^[a-f0-9]{64}$/.test(supplied)) return reply(401, { error: 'UNAUTHORIZED' })
    let mismatch = 0
    for (let i = 0; i < 64; i++) mismatch |= token.charCodeAt(i) ^ supplied.charCodeAt(i)
    if (mismatch !== 0) return reply(401, { error: 'UNAUTHORIZED' })
    if (req.method !== 'POST' || req.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return reply(400, { error: 'JSON_POST_ONLY' })
    let body: Record<string, unknown>
    try {
      const reader = req.body?.getReader()
      if (!reader) return reply(400, { error: 'INVALID_BODY' })
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 256) { await reader.cancel(); return reply(413, { error: 'BODY_TOO_LARGE' }) }
        chunks.push(value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      body = JSON.parse(new TextDecoder().decode(bytes))
      if (!body || Array.isArray(body) || Object.keys(body).length !== 3 ||
          Object.keys(body).some((key) => !['caseId', 'variant', 'repeat'].includes(key))) return reply(400, { error: 'FIXED_CASE_ONLY' })
    } catch { return reply(400, { error: 'INVALID_BODY' }) }
    const { caseId, variant, repeat } = body
    const sample = cases.find((item) => item.id === caseId)
    if (!sample || (variant !== 'before' && variant !== 'after') || (repeat !== 0 && repeat !== 1)) return reply(400, { error: 'INVALID_CASE' })
    const key = deps.env('GEMINI_API_KEY')
    if (!key) return reply(503, { error: 'PROVIDER_NOT_CONFIGURED' })
    const slot = `${caseId}:${variant}:${repeat}`
    if (used.has(slot)) return reply(409, { error: 'ALREADY_ATTEMPTED' })
    used.add(slot)
    let providerCalls = 0
    const traces: Array<Record<string, unknown>> = []
    const limitedFetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.origin !== 'https://generativelanguage.googleapis.com' || url.username || url.password ||
          url.pathname !== '/v1beta/models/gemini-3.1-flash-lite:generateContent' || init?.method !== 'POST' ||
          providerCalls >= 1 || deps.now() >= expires || deps.env('TONE_COMPLETION_PROBE_CONTROL') !== JSON.stringify(control)) {
        throw new Error('PROBE_SAFETY_STOP')
      }
      providerCalls++
      const response = await deps.fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(Math.min(30_000, expires - deps.now())) })
      const data = await response.clone().json().catch(() => ({}))
      const candidate = data.candidates?.[0]
      const visible = Array.isArray(candidate?.content?.parts) ? candidate.content.parts.filter((p: { text?: unknown; thought?: boolean } | null) => p && typeof p.text === 'string' && !p.thought) : []
      const total = visible.map((p: { text: string }) => p.text).join('')
      traces.push({ status: response.status, finishReason: candidate?.finishReason ?? 'MISSING', visibleParts: visible.length, providerChars: Array.from(total).length, usage: data.usageMetadata })
      return response
    }
    const started = deps.now()
    try {
      const pipeline = (variant === 'before' ? before : after)(limitedFetch, key)
      const response = await pipeline.handler(new Request('https://probe.invalid/correct', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          text: sample.text, formalMode: true, formalLevel: sample.tone, removePunct: false,
          formalIncludePunct: true, includeDialect: false, deviceId: 'synthetic-tone-only', requestId: crypto.randomUUID(),
        }),
      }))
      const result = await response.json()
      return reply(200, { caseId, variant, repeat, sourceSha256: variant === 'before' ? beforeHash : afterHash,
        correctionStatus: response.status, sourceChars: Array.from(sample.text).length,
        result: typeof result.result === 'string' ? result.result.split(key).join('[REDACTED]').split(token).join('[REDACTED]') : null,
        durationMs: deps.now() - started, providerCalls, traces, simulated: pipeline.metrics, realDatabaseCalls: 0, realCreditOperations: 0 })
    } catch { return reply(500, { error: 'PROBE_FAILED', providerCalls, traces }) }
  }
}
Deno.serve(createHandler())
