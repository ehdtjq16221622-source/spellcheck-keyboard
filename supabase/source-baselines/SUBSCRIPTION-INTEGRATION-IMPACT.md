# 구독 통합 브랜치: 다음 배포 영향

브랜치: `codex/subscription-integration-20261018`
기준: 운영 복구 커밋 `311b02f`. 운영에는 아직 배포하지 않았다.

## 비교의 구분

- 아래 표의 '통합 추가 영향'은 이 브랜치와 복구 커밋의 차이다.
- '다음 배포 주의'는 현재 운영과 비교할 때 남아 있는 차이까지 고려한다.
- 소스가 없는 함수는 배포할 수 있다고 표시하지 않았다. 루트 작업 폴더의 미커밋 파일이 이 브랜치에 자동으로 포함된 것으로 간주하지 않았다.
- 상대 import를 따라 실행에 쓰이는 파일을 비교했다. 원래 함수 디렉터리에 고정해 둔 미사용 사본도 배포 파일에는 남아 있지만, 구독 진입점은 새 공용 통합 파일을 사용한다.

## 함수별 영향표

| 함수 | 통합 추가 영향 | 다음 배포에서 달라지는 것 / 주의 |
|---|---|---|
| `sync_subscription_ios` | **있음** | v50의 portable 서명 검증 2경로·재조회·오류 코드·상세 실패 저장·알림을 유지. X509 호환, Detailed 검사 API 보존, 허용된 요청 출처/플랜 검증 결과 진단, 안전한 응답 code 추가. 공용 영수증 검증도 현재 운영과 같은 strict 옵션 지원으로 맞춤. TestFlight Sandbox 검증 전 배포 보류 |
| `language_study_generate` | **있음** | 공용 wallet_auth의 거절 원인 기록과 `activation_pending` 기록이 들어가고 Error 이름이 WalletAccessError로 분류됨. 성공 인증, 요청 ID, AI, 가격/차감 조건과 오류 문구·상태는 그대로. 운영에 이미 있는 거절 기록을 되살리는 효과이며 오류 이름 분류가 추가됨 |
| `apple_notifications` | 없음 | 함수 안에 고정한 v30 검증·크레딧·Telegram 사본 유지. 갱신 지급/환불 회수 유지 |
| `correct` | 없음 | 함수 안의 v163 인증/차감 사본 유지. 요청 ID 없는 사전 409와 느린 요청 감시 유지 |
| `get_credits` | 없음 | v27 지갑 한 곳의 잔액 표시 및 활성화 대기 코드 유지. 미배포 합산 표시는 별도 브랜치 |
| `link_apple_user` | 없음 | v27 legacy 1회 연결 RPC 및 409 지문 기록 유지 |
| `translate` | 없음 | v50 요청 ID 차단, 발음 규칙 및 함수 전용 인증 유지. 새 파서는 별도 브랜치 |
| `wallet_link_v2` | 없음 | v54의 8초 락 재시도, 계정 보너스 검토, 등록 경쟁 처리, resume_linked/합치기 안전장치 유지. pending 정책은 별도 브랜치 |
| `get_active_notice` | 없음 | 정렬한 운영 소스 유지 |
| `grant_manual_credits` | 없음 | 운영의 수동 지급 비활성 응답 유지 |
| `link_apple_user_canary` | 없음 | 운영과 같은 Apple 인증/처리 유지 |
| `subscriber_status` | 없음 | 운영 소스 유지 |
| `wallet_merge_preview` | 없음 | 운영 소스 유지 |
| `daily_checkin` | 없음 | 이 브랜치에 커밋된 옛 주 파일은 아직 운영 정렬 대상이 아님. 루트의 미커밋 진단/인증 작업과 다르며 배포 보류. 루트 작업까지 나중에 가져오면 공용 인증 영향표를 재계산해야 함 |
| `sync_subscription` | 없음 | 이 브랜치의 옛 주 파일은 운영 v22와 다름. 루트의 미커밋 원자 처리/인증/진단 작업을 함께 정리하기 전 배포 보류 |
| `telegram_bot` | 없음 | 운영 v19의 4초 전송 보장과 차이가 남아 있어 별도 운영 정렬 전 배포 보류 |
| `redeem_coupon` | 소스 없음 | 운영 v24는 기록돼 있지만 이 브랜치에 배포용 진입점이 없음. 루트 미추적 사본을 도입할 때 공용 wallet_auth 영향 재검토 |
| `sync_credit_usage` | 소스 없음 | 운영 v20은 기록돼 있지만 이 브랜치에 배포용 진입점이 없음. 도입할 때 공용 인증 영향 재검토 |
| `admob_ssv_callback` | 없음 | 기준 브랜치부터 공용 admob_ssv.ts 의존성이 누락됨. 루트 미추적 사본/수정까지 정리하기 전 배포 보류 |
| `reward_ad` | 없음 | 루트 작업 폴더에는 운영처럼 닫힌 미커밋 수정이 있으나 이 브랜치에 자동 반영되지 않음. 별도 운영 정렬 전 배포 보류 |
| `daily_digest` | 소스 없음 | 도입 때 운영 Telegram 사본과 공용 전송기의 차이를 재검토 |
| `admin_stats` | 없음 | 이번 공용 파일을 사용하지 않음 |
| `service_monitor` | 없음 | 이번 공용 파일 변경 없음 |
| `trigger_test_notification` | 없음 | 이번 공용 파일을 사용하지 않음. 삭제하지 않음 |
| `referral` | 소스 없음 | 운영 기록만 존재. 앱의 초대 기능 때문에 유지 필요; 5명/100과 10명/200 정책 불일치는 결정하지 않음 |
| `subscription_monitor` | 소스 없음 | 운영 기록/활성 cron 유지. 이번에 소스 도입/삭제하지 않음 |
| `model_benchmark_canary` | 소스 없음 | 이번 변경/배포/삭제 없음 |
| `spelling_benchmark_canary` | 소스 없음 | 이번 변경/배포/삭제 없음 |
| `tone_reasoning_benchmark_canary` | 소스 없음 | 이번 변경/배포/삭제 없음 |
| `tone_prompt_benchmark_canary` | 소스 없음 | 이번 변경/배포/삭제 없음 |
| `spelling_reasoning_benchmark_canary` | 소스 없음 | 이번 변경/배포/삭제 없음 |
| `spelling_100_benchmark_canary` | 소스 없음 | 이번 변경/배포/삭제 없음 |
| `luna_accuracy_benchmark_canary` | 소스 없음 | 이번 변경/배포/삭제 없음 |
| `luna_pure_proofing_benchmark` | 소스 없음 | 이번 변경/배포/삭제 없음 |
| `correct_model_compare_benchmark` | 소스 없음 | 이번 변경/배포/삭제 없음 |
| `correct_model_compare_benchmark_v2` | 소스 없음 | 이번 변경/배포/삭제 없음 |

현재 실행 의존성이 달라진 함수는 구독 본체와 외국어 공부 2개다. 그 외의 함수가 운영에 안전하게 재배포 가능하다는 의미는 아니다. 기존부터 남은 미정리 차이는 표에서 따로 표시했다.

## 인증 / 지급 조건 보존

- shared wallet_auth의 세션 조회·해시 확인·만료/취소·Apple 소유자·보호 지갑 거절 조건은 변경하지 않았다.
- 거절 기록은 try/catch 안에서 처리해 기록 실패가 인증 성공이나 거절 응답을 바꾸지 않는다.
- 위조 서명/다른 상품/만료/환불 상태의 활성 구독은 계속 거절한다. portable는 Apple 루트/인증서 연결/서명을 확인하는 대체 검증이며 검증 생략이 아니다.
- 지급 키, 원자 RPC, 잔액과 계정 귀속 정책은 그대로다. 실패 후 옛 분리 지급으로 돌아가지 않는다.
- `_shared/apple_x509_compat.ts`와 generic portable 도구는 기존 코드를 살렸다. 함수별로 고정된 다른 사본은 이 브랜치의 공용 변경에 따라 자동 갱신되지 않는다.

## 완료한 검사

- Deno 타입 검사: sync_subscription_ios, language_study_generate 통과.
- 오프라인 Node 시험: 복구 대응표/실제 요청 ID 차단, Apple 상태·portable fallback·X509, 영수증, 구독 진입점/상세 실패 기록.
- 외부 AI 호출 / 실제 Apple 거래 검증 / 운영 DB 쓰기 / Telegram 전송: 하지 않음.
- `verify_jwt` 설정 변경 없음. 운영 배포 없음.

## TestFlight Sandbox에서 이어서 할 일

1. 새 계정과 기존 계정의 로그인 후 지갑 세션이 준비된 상태에서 시험한다.
2. Sandbox 기본 플랜 구입, 상위 플랜 즉시 변경, 복원/재요청을 확인한다. 거래 한 주기에 지급이 1번인지 기록과 잔액으로 대조한다.
3. Apple 확인 지연 시 '확인 중/재시도'와 두 오류 코드가 구분되는지 확인한다. 지연을 성공으로 표시하지 않는다.
4. 만료/취소 거래, 지갑 소유권 충돌, 유효하지 않은 세션은 지급 없이 거절되는지 확인한다.
5. 실패 시 diagnostic_id, 거래 상세, clientDiag가 기록되는지 확인한다. 원문 토큰이나 비밀값을 결과에 포함하지 않는다.

주의: 현재 TestFlight가 운영 v50을 바라보면 이 새 브랜치를 시험하는 것이 아니다. 새 서버 코드의 Sandbox 실험에는 별도 시험 서버/엔드포인트 연결 계획이 필요하다. 이번 요청의 '무배포'를 지켜 그 환경 배포/앱 연결 변경은 하지 않았다. 실제 운영 배포는 Sandbox 시험 후 별도 지시로 진행한다.

## 환경 변수 정정

대표님 설명에 따라 계정용 SUPABASE_ACCESS_TOKEN은 PC 환경 변수에 새로 제공될 예정이다. 그 전에는 check-live를 반복 호출하거나 토큰을 추측하지 않고 읽기 전용 Supabase 연결로 비교한다. 이번에 환경 변수·토큰·운영 비밀 설정을 변경하지 않았다.
