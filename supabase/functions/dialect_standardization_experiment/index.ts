import { createPipeline as beforePipeline, sourceSha256 as beforeHash } from './generated-before.ts'
import { createPipeline as afterPipeline, sourceSha256 as afterHash } from './generated-after.ts'
import { cases } from './generated-cases.ts'

type Dependencies = {
  env: (name: string) => string | undefined
  fetch: typeof globalThis.fetch
  now: () => number
}

export function createExperimentHandler(deps: Dependencies = {
  env: (name) => Deno.env.get(name), fetch: globalThis.fetch, now: Date.now,
}) {
  // Per-isolate replay protection is not a project-wide billing cap.
  const used = new Set<string>()
  const reply = (status: number, body: unknown) => Response.json(body, {
    status, headers: { 'Cache-Control': 'no-store' },
  })
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return reply(405, { error: 'POST_ONLY' })
    const secret = deps.env('DIALECT_EXPERIMENT_TOKEN') ?? ''
    const starts = Date.parse(deps.env('DIALECT_EXPERIMENT_STARTS_AT') ?? '')
    const expires = Date.parse(deps.env('DIALECT_EXPERIMENT_EXPIRES_AT') ?? '')
    const now = deps.now()
    if (deps.env('DIALECT_EXPERIMENT_OPEN') !== 'true' || !/^[a-f0-9]{64}$/.test(secret) ||
        !Number.isFinite(starts) || !Number.isFinite(expires) || expires <= starts ||
        expires - starts > 15 * 60_000 || now < starts || now >= expires) {
      return reply(410, { error: 'EXPERIMENT_CLOSED' })
    }
    const supplied = req.headers.get('x-dialect-experiment-token') ?? ''
    if (!/^[a-f0-9]{64}$/.test(supplied)) return reply(401, { error: 'UNAUTHORIZED' })
    let mismatch = 0
    for (let i = 0; i < 64; i++) mismatch |= secret.charCodeAt(i) ^ supplied.charCodeAt(i)
    if (mismatch !== 0) return reply(401, { error: 'UNAUTHORIZED' })
    if (req.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
      return reply(415, { error: 'JSON_ONLY' })
    }
    let body: Record<string, unknown>
    try {
      // Bound the stream rather than trusting a caller-supplied Content-Length.
      const reader = req.body?.getReader()
      if (!reader) return reply(400, { error: 'INVALID_BODY' })
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 1024) { await reader.cancel(); return reply(413, { error: 'BODY_TOO_LARGE' }) }
        chunks.push(value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      body = JSON.parse(new TextDecoder().decode(bytes))
      if (!body || Array.isArray(body) || Object.keys(body).length !== 3 ||
          Object.keys(body).some((key) => !['caseId', 'variant', 'includeDialect'].includes(key))) {
        return reply(400, { error: 'FIXED_CASES_ONLY' })
      }
    } catch { return reply(400, { error: 'INVALID_BODY' }) }
    const { caseId, variant, includeDialect } = body
    if (!Number.isInteger(caseId) || typeof includeDialect !== 'boolean' ||
        (variant !== 'before' && variant !== 'after')) return reply(400, { error: 'INVALID_CASE' })
    const sample = cases.find((item) => item.id === caseId)
    if (!sample) return reply(400, { error: 'INVALID_CASE' })
    if (!includeDialect && deps.env('DIALECT_EXPERIMENT_ALLOW_PAID_OFF') !== 'true') {
      return reply(403, { error: 'PAID_OFF_NOT_APPROVED' })
    }
    // Use the existing runtime key in Edge; never download or duplicate its value.
    const geminiKey = deps.env('GEMINI_API_KEY')
    if (!geminiKey) return reply(503, { error: 'PROVIDER_NOT_CONFIGURED' })
    const slot = `${variant}:${caseId}:${includeDialect}`
    if (used.has(slot)) return reply(409, { error: 'ALREADY_ATTEMPTED' })
    used.add(slot)
    const calls: Array<Record<string, unknown>> = []
    let stopped = false
    const redact = (value: string) => value.split(geminiKey).join('[REDACTED]').split(secret).join('[REDACTED]')
    const limitedFetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.origin !== 'https://generativelanguage.googleapis.com' || url.username || url.password ||
          url.pathname !== '/v1beta/models/gemini-3.1-flash-lite:generateContent' ||
          init?.method !== 'POST' || stopped || calls.length >= 4 || deps.now() >= expires ||
          deps.env('DIALECT_EXPERIMENT_OPEN') !== 'true' || deps.env('DIALECT_EXPERIMENT_TOKEN') !== secret ||
          (!includeDialect && deps.env('DIALECT_EXPERIMENT_ALLOW_PAID_OFF') !== 'true')) {
        throw new Error('EXPERIMENT_SAFETY_STOP')
      }
      const request = JSON.parse(String(init.body))
      const trace: Record<string, unknown> = {
        structuredEdits: request.generationConfig.responseMimeType === 'application/json',
      }
      calls.push(trace)
      try {
        const response = await deps.fetch(input, {
          ...init, redirect: 'error', signal: AbortSignal.timeout(Math.min(20_000, expires - deps.now())),
        })
        trace.status = response.status
        if (response.status === 401 || response.status === 403) stopped = true
        const data = await response.clone().json().catch(() => ({}))
        trace.finishReason = data.candidates?.[0]?.finishReason
        trace.usage = data.usageMetadata
        trace.rawResult = redact(data.candidates?.[0]?.content?.parts?.[0]?.text ?? '')
        return response
      } catch {
        trace.transportFailure = true
        throw new Error('PROVIDER_TRANSPORT_FAILURE')
      }
    }
    const start = deps.now()
    try {
      const pipeline = (variant === 'before' ? beforePipeline : afterPipeline)(limitedFetch, geminiKey)
      const response = await pipeline.handleCorrection(new Request('https://experiment.invalid/correct', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: sample.text, formalMode: false, removePunct: true, includeDialect,
          deviceId: 'synthetic-dialect-only', requestId: crypto.randomUUID(),
        }),
      }))
      const result = await response.json()
      return reply(200, {
        caseId, variant, includeDialect, sourceSha256: variant === 'before' ? beforeHash : afterHash,
        correctionStatus: response.status, result: redact(result.result ?? ''),
        diagnosticId: result.diagnostic_id, failureStage: result.failure_stage,
        durationMs: deps.now() - start, calls, simulated: pipeline.metrics,
        realDatabaseCalls: 0, realCreditOperations: 0,
      })
    } catch { return reply(500, { error: 'EXPERIMENT_FAILED', calls }) }
  }
}

Deno.serve(createExperimentHandler())
