import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'

const dir = new URL('./', import.meta.url)
const read = (name) => JSON.parse(readFileSync(new URL(name, dir), 'utf8'))
const files = readdirSync(dir).filter((name) => /^results-\d+\.json$/.test(name))
assert.equal(files.length, 1)
const run = read(files[0])
const cases = read('cases.json')
const closure = read('closure.json')
assert.equal(run.results.length, 60)
assert.equal(run.providerAttempts, 60)
assert.ok(run.results.every((row) => row.correctionStatus === 200 && row.calls.every((call) => call.status === 200 && call.finishReason === 'STOP')))
assert.equal(closure.closed, true)
assert.equal(closure.closedStatus, 410)
const dialect = cases.filter((row) => ['dialect', 'mixed_errors', 'multi_clause'].includes(row.category))
assert.equal(dialect.length, 23)
// Manual linguistic review of this specific one-pass batch, not a universal accuracy score.
const beforeFullyStandardized = new Set([9, 12, 16, 19])
const notes = {
  7: '표준어 변환 완료. 다만 내가/한테/줘 → 제가/께/주세요로 높임 정도도 변함. 전역 말투 유지 제한을 제거한 결과로, 허용 범위 검토 권장.',
  10: '표준어 변환 완료. 챙길란다 → 챙겨야겠다로 계획이 필요성처럼 읽힐 여지 있음. 뜻의 미세한 차이 검토 권장.',
  14: '표준어 변환 완료. 아따 → 아이고로 감탄사 선택도 바뀜. 수량·감정 표시는 보존.',
  21: '회귀: 이미 표준어인 쓸 만하구먼 → 쓸 만하네요로 불필요한 변경. 새 후보의 확정 보완 대상.',
  26: '전후 모두 왔데? → 왔대?로 바뀜. 띄어쓰기 문제가 아니라 전달/경험의 뜻이 모호한 사례이므로 정답 확정 보류. 새 후보만의 회귀는 아님.',
  30: '세 문장 전체의 주체·시각·부정·전달·회의·예약 2개 유지. 관찰된 누락 없음.',
}
const summary = {
  review: 'completed_with_regression_do_not_promote_unchanged',
  measuredAt: run.finishedAt, correctionJobs: 60, actualProviderCalls: run.providerAttempts,
  httpOrCorrectionErrors: 0, incompleteProviderResults: 0,
  manualDialectReview: { sampleSize: 23, beforeFullyStandardized: 4, afterFullyStandardized: 23, criterion: 'All dialect words/endings replaced, separate from strict meaning/style acceptability' },
  manualControlReview: { standardCases: 3, beforeUnnecessaryChanges: 0, afterUnnecessaryChanges: 1, regressionIds: [21], ambiguousBothVariantsId: 26 },
  manualMeaningReview: { observedMajorClauseOmissions: 0, reviewNuanceIds: [7, 10], note: 'Not all outputs declared fully correct; one observation per variant only' },
  protectedLiteralLosses: [], variants: {}, closure,
}
for (const variant of ['before', 'after']) {
  const rows = run.results.filter((row) => row.variant === variant)
  const times = rows.map((row) => row.durationMs).sort((a, b) => a - b)
  summary.variants[variant] = {
    corrections: rows.length, medianServerMs: (times[14] + times[15]) / 2,
    providerTokens: rows.reduce((sum, row) => sum + row.calls.reduce((n, call) => n + (call.usage?.totalTokenCount ?? 0), 0), 0),
  }
  for (const row of rows) {
    const sample = cases.find((item) => item.id === row.caseId)
    for (const literal of sample.protected) if (!row.result.includes(literal)) summary.protectedLiteralLosses.push({ caseId: row.caseId, variant, literal })
  }
}
assert.equal(summary.protectedLiteralLosses.length, 0)
writeFileSync(new URL('summary.json', dir), JSON.stringify(summary, null, 2) + '\n')
const escape = (s) => s.replaceAll('|', '\\|').replaceAll('\n', '<br>')
const lines = [
  '# 사투리 교정: 실제 Supabase 전후 30문장 비교', '',
  '## 결론', '',
  '사투리 표준화는 23개 중 4개 → 23개로 개선됐습니다. 다만 이미 표준어인 문장을 불필요하게 바꾼 회귀 1개가 있어, 이 후보를 그대로 운영에 적용하지 않는 것을 추천합니다.', '',
  '- 실행: 2026-10-19 18:51:44~18:53:00 KST. 교정 60건, 실제 Gemini 호출 60회, 오류·미완료 0건.',
  '- 시험 경로 명시적 종료 확인: 18:53:02 KST, HTTP410. 잘못된 별도 인증번호는 HTTP401로 거절.',
  '- 사투리 포함 23개, 이미 표준어 3개, 모호한 표현 3개, 영어 1개. 각 조건 1번씩의 작은 표본이며 장기 품질을 보장하지 않음.',
  '- 숫자·URL·영문 기호·감정 표시의 지정 보호 문자열 누락 0건. 수동 검토에서 큰 문장·절 누락은 관찰되지 않음. 미세한 높임/의도 변화는 아래 보류 항목 참조.',
  '- 지갑·크레딧·DB 쓰기 0건: 실제 AI 처리 앞뒤의 지갑/차감/느린 요청 기록은 시험용 대체 구현. 운영 인증·잔액 처리의 종단간 시험은 아님.',
  '- 사투리 OFF 67조합, 말투 64조합은 지시문이 동일함을 로컬에서 검증. 실제 유료 OFF/말투 시험은 하지 않음.',
  `- 서버 내부 처리 중간값: 전 ${summary.variants.before.medianServerMs}ms / 후 ${summary.variants.after.medianServerMs}ms. 앱 왕복/기기 입력 속도 측정이 아니며 속도 개선을 단정하지 않음.`,
  '- 모델·재시도·안전 검사·편집 목록 복구는 양쪽 모두 운영 correct v167 코드 기준. 새 지시문만 후보에 추가. 사용자용 correct 소스/설정은 변경하지 않음.',
  '- 비밀 설정 변경 뒤 메타데이터 버전은 correct v170 / 시험 함수 v4로 올라갔으나, 재다운로드 코드 대조는 둘 다 차이 0. correct의 지시문은 여전히 변경 전.', '',
  '## 배포 전 보완 권장', '',
  '1. 이미 표준어인 구절은 유지한다는 규칙을 구체화: 구먼 같은 표준어 어미는 변환 대상이 아님. 기존 사투리를 유지하라는 전역 제한은 되살리지 않음.',
  '2. 높임 변화(7번), 계획→필요성으로 읽힐 수 있는 변화(10번), 모호한 전달/경험(26번)을 고정 회귀 사례로 유지.',
  '3. 이번 후보의 유료 재시험이나 운영 correct 배포는 추가로 하지 않음. 검토 결과를 바탕으로 다음 변경을 결정.', '',
  '## 30문장 전체', '',
  '| 번호 | 원문 | 현재 운영 지시문 결과 | 새 후보 결과 | 판정/주의 |',
  '|---|---|---|---|---|',
]
for (const sample of cases) {
  const before = run.results.find((row) => row.caseId === sample.id && row.variant === 'before')
  const after = run.results.find((row) => row.caseId === sample.id && row.variant === 'after')
  let note = notes[sample.id]
  if (!note && dialect.includes(sample)) note = `표준어 변환 완료. 전 ${beforeFullyStandardized.has(sample.id) ? '완료' : '사투리 잔존'} → 후 완료.`
  if (!note) note = '대조군 유지. 불필요한 변경 없음.'
  lines.push(`| ${sample.id} | ${escape(sample.text)} | ${escape(before.result)} | ${escape(after.result)} | ${note} |`)
}
writeFileSync(new URL('RESULTS.md', dir), lines.join('\n') + '\n')
console.log(JSON.stringify(summary, null, 2))
