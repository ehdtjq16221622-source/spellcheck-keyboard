export type ProofingEdit = {
  find: string
  replace: string
  reason?: string
}

export type ProofingEditResult = {
  result: string
  accepted: ProofingEdit[]
  rejected: Array<ProofingEdit & { rejection: string }>
}

export function parseProofingEdits(raw: string): ProofingEdit[] {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('proofing JSON object not found')

  const parsed = JSON.parse(cleaned.slice(start, end + 1))
  if (!Array.isArray(parsed?.edits)) throw new Error('proofing edits is not an array')

  return parsed.edits.map((edit: unknown) => {
    const candidate = edit as Record<string, unknown>
    return {
      find: typeof candidate?.find === 'string' ? candidate.find : '',
      replace: typeof candidate?.replace === 'string' ? candidate.replace : '',
      reason: typeof candidate?.reason === 'string' ? candidate.reason : undefined,
    }
  })
}

export function applyValidatedProofingEdits(source: string, rawEdits: ProofingEdit[]): ProofingEditResult {
  const accepted: Array<ProofingEdit & { start: number; end: number }> = []
  const rejected: Array<ProofingEdit & { rejection: string }> = []

  for (const edit of rawEdits.slice(0, 24)) {
    if (!edit.find || edit.find === edit.replace) {
      rejected.push({ ...edit, rejection: 'empty_or_unchanged' })
      continue
    }

    const matches = findOccurrences(source, edit.find)
    if (matches.length !== 1) {
      rejected.push({ ...edit, rejection: `match_count_${matches.length}` })
      continue
    }

    const distance = levenshtein(edit.find, edit.replace)
    const maxDistance = Math.max(4, Math.ceil(edit.find.length * 0.45))
    if (distance > maxDistance) {
      rejected.push({ ...edit, rejection: 'replacement_too_different' })
      continue
    }

    const start = matches[0]
    const end = start + edit.find.length
    if (accepted.some((item) => start < item.end && end > item.start)) {
      rejected.push({ ...edit, rejection: 'overlap' })
      continue
    }

    accepted.push({ ...edit, start, end })
  }

  let result = source
  for (const edit of [...accepted].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.replace + result.slice(edit.end)
  }

  const totalDistance = levenshtein(source, result)
  const maxTotalDistance = Math.max(6, Math.ceil(source.length * 0.35))
  if (totalDistance > maxTotalDistance || !preservesProtectedTokens(source, result)) {
    return {
      result: source,
      accepted: [],
      rejected: [
        ...rejected,
        ...accepted.map(({ start: _start, end: _end, ...edit }) => ({ ...edit, rejection: 'result_guard' })),
      ],
    }
  }

  return {
    result,
    accepted: accepted.map(({ start: _start, end: _end, ...edit }) => edit),
    rejected,
  }
}

function findOccurrences(source: string, needle: string): number[] {
  const indexes: number[] = []
  let from = 0
  while (from <= source.length - needle.length) {
    const index = source.indexOf(needle, from)
    if (index < 0) break
    indexes.push(index)
    from = index + Math.max(1, needle.length)
  }
  return indexes
}

function protectedTokens(text: string): string[] {
  return text.match(
    /https?:\/\/\S+|[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*|\d+(?:[.:]\d+)*|[ㅋㅎㅠㅜㅡ]{2,}|\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*|[.,!?;:'"“”‘’…~]/gu
  ) ?? []
}

function preservesProtectedTokens(source: string, result: string): boolean {
  const remaining = [...protectedTokens(result)]
  for (const token of protectedTokens(source)) {
    const index = remaining.indexOf(token)
    if (index < 0) return false
    remaining.splice(index, 1)
  }
  return remaining.length === 0
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]
    previous[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j]
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
      diagonal = above
    }
  }
  return previous[b.length]
}
