# 안드로이드·해외 출시 서버 작업 (2026-11-14)

브랜치 `claude/global-android-server`(워크트리 `C:\Users\82108\.android\kb-global`)는 `claude/max-plan`(f2d2f18)에서 시작했다. 로컬 커밋 3개가 있다.

| 커밋 | 내용 |
| --- | --- |
| 2aa1224 | 구글 로그인 지갑, 플레이 크레딧 묶음 구매 확인 |
| b15ecc2 | 안드로이드 현재 플랜 구독, 플레이 실시간 알림 수신 |
| 8cdee9c | 영어·일본어 AI 교정 |

**2026-11-14 17:04–17:06 UTC 운영 반영 완료(사용자 승인).** 브랜치는 푸시하지 않았다.
- DB: 마이그레이션 3개 적용(`…100000`, `…110000`, `…120000` 신규 가입 보너스). 검사 2개 VALIDATE 완료, 새 함수 6개는 service_role만 실행 가능, 새 테이블 2개 RLS 켜짐·anon 접근 없음. 행 수 27,326 그대로.
- 함수: wallet_link_v2 v68, credit_pack_purchase v2, sync_subscription v34, google_play_notifications v1(신규), correct v178. 모두 `verify_jwt=false`(기존과 같음).
- 배포본은 **라이브 소스 + 이번 변경만**으로 만들었다. 이 브랜치의 `functions/correct`는 라이브보다 오래된 버전이다(라이브는 `consume_ai_credit_attempt` 방식, 시간 제한 10초). 그래서 correct는 라이브 v177에 언어 기능만 얹어 배포했다. **이 브랜치의 correct 소스로 배포하면 안 된다.** (2026-11-15 해소: `codex/ai-10s-release-check`를 합쳐서(f70c09c) 이제 이 브랜치의 correct는 라이브 v178 + 아직 배포 안 한 영어·일본어 강화분이다. 단 `_shared/credits.ts`에는 출시 전인 Max 플랜 3줄이 더 있다.) sync_subscription은 라이브의 `credits.ts`·`subscription_audit.ts`를 유지했다(아직 출시 전인 Max 플랜 매핑 제외).
- 스위치 `WALLET_GOOGLE_SIGN_IN_ENABLED`, `GOOGLE_RTDN_ENABLED`는 꺼져 있다. 확인: 구글 sign_in 404, RTDN 404, 지갑 availability 200, correct 요청 ID 없음 409.
- 신규 가입 보너스: 구글 계정당 1회 500(`grant_google_signup_bonus_once`, 원장 키 `google-signup:<subject>`). 게스트 지갑을 처음 구글 계정에 연결(`link`, decision `linked`)할 때 지급하고, 응답에 `signupBonusGranted`가 붙는다. 이미 구글 지갑이 있는 계정·Apple 연결에는 없다. 지급이 실패해도 연결은 성공하고, 같은 키로 다시 link하면 다시 시도한다.

## 상태 구분

| 항목 | 상태 |
| --- | --- |
| 코드 | 완료 |
| 서버 소스 테스트 (`node --test supabase/tests/*.test.mjs`) | 277개 중 272개 통과. 실패 5개는 모두 "배포 기록본과 소스가 같은가" 검사다. 그중 4개(correct, translate, sync_credit_usage, sync_subscription)는 이번 작업 전부터 실패했다. wallet_link_v2 1개는 소스를 고쳐서 새로 실패하며, 배포 후 기록본을 갱신하면 통과한다. |
| SQL 테스트 (PGlite, `supabase/tests/wallet-postgres-sandbox`) | 36개 모두 통과. 새 테스트는 구글 묶음 6개, 구글 구독 6개다. |
| 실제 모델 교정 평가 (`correction-eval-global/run.mjs`) | 48개 모두 통과, 두 번 돌려 같은 결과. 영어·일본어 교정 각 20개, 말투 8개. 모델은 gemini-3.1-flash-lite이고 운영과 같은 설정이다. |
| 운영 DB 반영 / 배포 | 완료(위 참고). 시크릿·콘솔 설정과 스위치 켜기는 남았다. |
| 실제 구글 로그인·플레이 결제 | 확인하지 못했다. 안드로이드 앱 구현과 콘솔 설정이 먼저 있어야 한다. |

## 바뀐 것

### 1. 구글 로그인 지갑 (`wallet_link_v2`)
- 요청에 `provider: 'google'`과 `identityToken`(구글 ID 토큰)을 함께 보낸다. 서버는 구글 공개키로 토큰을 확인한다. audience는 `GOOGLE_OAUTH_CLIENT_IDS`에 등록된 값이어야 한다.
- 지갑 주인 값은 `google:<구글 계정 ID>`다. 기존 Apple 값과 같은 칸(`device_credits.apple_user_id`, `credit_wallet_sessions.apple_sub`)에 저장한다. 그래서 세션 발급·갱신, 연결, 합치기, 다른 함수들의 지갑 확인(`wallet_auth`)이 **코드 수정 없이 그대로** 동작한다.
- 두 계정 종류가 섞이지 않게 DB 검사를 두 가지 추가했다.
  - `google:`로 시작하는 지갑 ID는 만들 수 없다. 운영 DB에서 확인한 결과 해당 행은 0개다.
  - `google:` 주인은 v2 지갑만 가질 수 있다.
- 구글 계정 손님 지갑에 걸린 구독은 Apple 확인으로 옮기지 않는다. "확인 필요"로 남기고 절대 이동하지 않는다.
- 켜는 스위치는 `WALLET_GOOGLE_SIGN_IN_ENABLED=true`다. 이 값이 없으면 구글 요청은 모두 404다.

### 2. 플레이 크레딧 묶음 (`credit_pack_purchase`, `platform: 'android'`)
- 앱 흐름:
  1. `account_token`을 받는다.
  2. Play Billing으로 구매하면서 `setObfuscatedAccountId(account_token)`를 넣는다.
  3. `claim`에 `product_id`, `purchase_token`을 보낸다.
- 서버는 구글 서버 기록(`purchases.products.get`)만 믿는다.
  - 결제 상태, 계정 토큰 일치, 수량 1, 보상형 상품 아님, 주문번호를 확인한다.
  - 한 번만 지급하고, 지급 뒤 서버가 consume한다.
  - 상품 ID와 크레딧 수는 iOS와 같다: `com.kingboard.app.credits_7000` = 7,000, `credits_18000` = 18,000.
- 응답:
  - `granted` / `already_granted` / `refunded` / `sandbox_limit`: 최종 결과다.
  - `consumed: false`가 붙으면 다음 실행 때 같은 구매로 claim을 다시 부르면 된다. 지급은 중복되지 않는다.
  - `pending`(202): 편의점 결제처럼 아직 끝나지 않은 결제다. 완료되면 실시간 알림이 지급한다.
- 라이선스 테스터 구매는 Sandbox로 기록한다. Apple Sandbox와 합쳐 30일에 3회까지만 지급한다.
- DB 테이블: `credit_pack_google_purchases`, `credit_pack_google_refunds`.
- DB 함수: `grant_google_credit_pack_once`, `refund_google_credit_pack_once`, `credit_pack_wallet_for_account_token`.
- 원장 키는 `gp:<주문번호>`다.

### 3. 안드로이드 구독, 현재 플랜 (`sync_subscription`)
- 대상 상품은 `com.kingboard.app.monthly_basic`, `monthly_premium`, `monthly_pro`, `monthly_max`다. 크레딧은 iOS와 같고(4,000 / 9,000 / 30,000 / 50,000), 테스트가 iOS 값과 같은지 검사한다.
- 로그인한 지갑 세션이 필수다. 구독의 `obfuscatedAccountId`가 지갑 계정 토큰과 같아야 한다. 클라이언트가 보낸 패키지 이름은 믿지 않는다.
- 플랜 변경(업그레이드·다운그레이드·재구독)은 구글이 새 토큰에 "이전 토큰"(linkedPurchaseToken)을 적어 준 경우에만 새 토큰으로 옮긴다.
- 자동 갱신을 끈 구독도 만료일까지는 이용 중으로 본다. 유예 기간·보류·일시정지는 새로 지급하지 않는다.
- 서버가 구독 확인(acknowledge)까지 한다.
- 예전 안드로이드 플랜(`kingboard_monthly_500/1000`)의 경로는 그대로다.
- DB 함수: `sync_google_subscription_v2_once`, `expire_google_subscription_credits`.

#### 2026-11-15 출시 전 검토에서 고친 것 (**2026-11-16 04:07–04:09 UTC 운영 반영 완료**, 사용자 승인)
반영 내용: 마이그레이션 적용(함수 교체, 서명·권한 그대로), sync_subscription v35, google_play_notifications v2, wallet_link_v2 v69, credit_pack_purchase v3, correct v179(영어·일본어 프롬프트 강화 포함). 배포본은 라이브 소스에 이번 변경만 얹었고, `credits.ts`·`subscription_audit.ts`는 라이브 것을 유지했다(Max 플랜 미출시). 스위치는 그대로 꺼져 있다. 배포 전후 응답 코드가 같고, 배포 후 실제 교정 요청은 정상 처리됐다.

마이그레이션 `20261115100000_google_subscription_guards.sql`(함수 교체만, 테이블 변경 없음)와 함수 `sync_subscription`, `google_play_notifications`, `wallet_link_v2`, `credit_pack_purchase`.
- **만료 후 재구독이 막히던 문제.** 구글은 완전히 만료된 뒤 다시 구독하면 "이전 토큰" 없이 새 토큰을 준다. 예전 규칙으로는 전부 "확인 필요"로 떨어져 결제하고도 크레딧을 못 받았다. 이제 지갑에 저장된 구독이 끝난 상태면 새 토큰으로 바꾸고 정상 지급한다.
- **플랜 바꾸기로 크레딧을 공짜로 다시 채우는 구멍.** 구글은 돈을 내지 않는 플랜 변경 방식(WITH_TIME_PRORATION, WITHOUT_PRORATION)과 해지 후 재가입을 허용하고, 그때마다 새 토큰을 준다. 예전 규칙은 새 토큰마다 플랜 크레딧을 통째로 다시 줬다. 이제 결제한 기간이 남아 있는 동안의 플랜 변경은
  - 잔액을 줄이지 않고,
  - 새 토큰이 새 한 달을 통째로 시작할 때(만료일이 27일 이상 남음 = 전액 결제 방식)만 "새 플랜 크레딧 − 이번 기간에 이미 쓴 양"까지 채우고,
  - 그 밖에는 잔액을 그대로 둔다. 새 플랜 크레딧은 다음 갱신 때 들어온다.
  - iOS와 다른 점: iOS 업그레이드는 새 플랜 크레딧을 통째로 준다. 안드로이드는 이번 기간에 쓴 만큼을 뺀다.
- **다른 지갑의 구독을 이어받는 토큰은 거부한다.** 결제 하나가 지갑 여러 개에 지급되는 것을 막는다.
- **결제 보류·만료 뒤 구독 크레딧이 안 지워지던 문제.** 구글은 보류·만료 상태에서 만료 시각을 과거로 돌려준다. 예전 규칙은 이를 "오래된 정보"로 보고 거부해서, 최종 만료 때 크레딧을 지우는 단계까지 가지 못했다. 이제 오래된 정보 검사는 이용 중 상태에만 적용한다.
- **플레이 스토어에서 직접 재구독한 경우.** 계정 표시(obfuscatedAccountId)가 없으므로, 구글이 알려 주는 "만료된 이전 구독"이 이 지갑 것일 때만 받아들인다.
- **알림 재전송 폭주 방지.** 결제 대기, 다음 갱신 때 적용될 플랜 변경, 플랜 변경 후의 옛 토큰, 구글에 기록이 없는 토큰은 200으로 조용히 끝낸다(텔레그램 알림 없음). 구글 장애(5xx)일 때만 500으로 다시 받는다. 환불 알림은 구글 장애 때 버리지 않고 다시 받는다.
- **가입 보너스:** DB 오류 시 서버가 한 번 더 시도한다.

### 4. 플레이 실시간 알림 (`google_play_notifications`, 새 함수)
- Pub/Sub 인증 푸시만 받는다. 구글 서명, audience, 서비스 계정 이메일을 확인한다.
- 처리하는 알림:
  - 앱 밖에서 끝난 묶음 결제: 지급하고 consume한다.
  - 묶음 환불·취소: 유료 크레딧에서 회수한다. Apple과 같은 규칙이고, 부족하면 텔레그램으로 알린다.
  - 구독 갱신·플랜 변경: 앱과 같은 동기화를 한다.
  - 최종 만료: 구독 크레딧을 없앤다(11/06 정책).
  - 구독 환불: 텔레그램으로 알리기만 하고 자동 회수는 하지 않는다.
- 응답 코드: 200은 처리 완료, 401은 구글이 보낸 요청이 아님, 500은 나중에 재전송.
- 켜는 스위치는 `GOOGLE_RTDN_ENABLED=true`다.

### 5. 영어·일본어 AI 교정 (`correct`)
- 요청에 `language`(`en`, `ja`, `en-US` 같은 지역 표기 포함)를 추가했다. **값이 없거나 그 밖의 값이면 지금 한국어 프롬프트와 글자 하나 다르지 않다.** 그래서 지금 앱들은 영향을 받지 않는다.
- 모델, 크레딧 종류, 차감량(교정 10, 말투 30)은 같다.
- 교정 프롬프트: 사용자 말투를 유지한다. 소문자 캐주얼 채팅, 줄임말·은어, 이모지, URL, 일본어 です・ます 문체를 그대로 둔다.
- 말투 프롬프트: 앱의 말투 키 7개와 커스텀에 대응하는 영어·일본어 지시를 넣었다.
- 모델이 글을 크게 잘라 먹으면 원문을 그대로 돌려준다.
- **주의:** `functions/correct/index.ts`에는 배포되지 않은 AI 시간 제한 작업(`codex/ai-10s-release-check`)이 함께 들어 있다. 운영은 그 작업이 없는 v174다. 배포하면 두 작업이 같이 나간다.

## 배포 순서 (승인 후)

1. **마이그레이션 2개를 운영 DB에 적용한다:** `20261114100000_google_accounts_and_play_packs.sql`, `20261114110000_google_subscriptions_v2.sql`.
   - 새 테이블과 함수만 추가하고, `device_credits`에 검사 2개를 건다.
   - 검사는 NOT VALID로 건 뒤 VALIDATE한다. 약 25,000행을 검사하는 동안 짧게 잠긴다.
   - 적용 전후로 행 수, 검사, 권한을 읽기 전용으로 확인한다.
2. **시크릿을 넣는다:**
   - `GOOGLE_OAUTH_CLIENT_IDS`: 구글 로그인 웹 클라이언트 ID.
   - `GOOGLE_PLAY_PACKAGE_NAME`: 지금은 `com.spellcheck.keyboard`. 패키지를 바꾼다면 그 값.
   - `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`: 이미 있다. 이 계정에 플레이 콘솔의 "재무 데이터 보기"와 "주문 및 구독 관리" 권한이 있어야 한다.
   - `GOOGLE_RTDN_PUSH_AUDIENCE`, `GOOGLE_RTDN_PUSH_SERVICE_ACCOUNT`.
3. **함수를 배포한다:** `credit_pack_purchase`, `sync_subscription`, `wallet_link_v2`, `google_play_notifications`(`--no-verify-jwt`), `correct`.
   - 앞의 넷은 스위치가 꺼진 상태로 배포하므로 지금 iOS 사용자에게 영향이 없다.
   - 배포 후 `live-functions` 기록본과 `DEPLOYS.md`를 갱신한다.
4. **안드로이드 내부 테스트 트랙에서 확인한다:** 구글 로그인 → 묶음 구매(라이선스 테스터) → 구독 → 환불·만료 알림.
5. **스위치를 켠다:** `WALLET_GOOGLE_SIGN_IN_ENABLED`, `GOOGLE_RTDN_ENABLED`.

**롤백:**
- 스위치를 끄면 구글 경로는 바로 멈춘다.
- 함수는 기록본(`live-functions`)으로 다시 배포한다.
- 마이그레이션의 테이블·함수는 남겨 둬도 아무것도 하지 않는다.
- 이미 지급한 크레딧이나 구글 쪽 결제는 롤백으로 되돌아가지 않는다.

## 사용자가 할 일 / 결정할 것

- **구글 클라우드 콘솔:** OAuth 클라이언트를 만든다. 웹 클라이언트 1개(서버 audience)와 안드로이드 클라이언트 1개(패키지명과 서명 SHA-1)가 필요하다.
- **플레이 콘솔:**
  - 상품 ID를 iOS와 같게 만든다: 묶음 2개, 구독 4개, 평생권 `com.kingboard.app.features_lifetime`.
  - 국가별 가격을 정한다.
  - 라이선스 테스터를 등록한다.
  - 실시간 알림용 Pub/Sub 토픽과 인증 푸시 구독을 만든다. 알림 범위는 "구독, 무효화된 구매, 모든 일회성 제품"으로 고른다(묶음 결제 완료·환불 알림에 필요).
  - 크레딧 묶음 상품의 "여러 개 구매"(수량 선택)는 끈 채로 둔다. 서버는 수량 1만 지급한다.
  - 구독 유예 기간은 7일 이하로 둔다.
- **결정 1 – 안드로이드 신규 가입 보너스:** 확정·반영(2026-11-14). 구글 계정당 1회 500. 남은 위험: 구글 계정을 여러 개 만들면 계정마다 받는다. 악용이 보이면 Play Integrity를 추가한다.
- **결정 2 – 한 사람이 iOS(Apple)와 안드로이드(구글)를 둘 다 쓸 때:** 지금은 지갑이 두 개로 나뉜다. 두 지갑을 합치는 기능은 없다.
  - 권장: 1차 출시는 따로 두고, 수요가 보이면 "다른 계정 연결"을 추가.
- **결정 3 – 안드로이드 구독 환불:** 지금은 텔레그램 알림 후 사람이 처리한다. Apple 구독 환불과 같은 방식이다.

## 안드로이드 앱(Codex) 연결 규격

- **로그인:** Credential Manager로 구글 ID 토큰을 받는다(serverClientId = 웹 클라이언트 ID). 그다음 `wallet_link_v2`를 부른다.
  - `{ action: 'link' | 'sign_in' | 'activate_session' | ..., provider: 'google', identityToken }`
  - 순서는 iOS Apple 로그인과 같다.
- **묶음:**
  - `credit_pack_purchase { action: 'account_token', platform: 'android', wallet_id }`
  - 구매 시 `setObfuscatedAccountId(account_token)`
  - `{ action: 'claim', platform: 'android', wallet_id, product_id, purchase_token }`
  - 최종 결과를 받기 전에는 앱에서 consume하지 않는다. 다음 실행 때 미소비 구매를 다시 claim한다.
- **구독:**
  - 구매 시 `setObfuscatedAccountId(account_token)`(묶음과 같은 토큰)
  - `sync_subscription { deviceId: wallet_id, productId, purchaseToken }`, 지갑 세션 헤더 필수.
  - 앱에서 acknowledge할 필요는 없다. 서버가 한다.
  - 플랜 변경 방식: 업그레이드는 `CHARGE_FULL_PRICE`, 다운그레이드는 `DEFERRED`만 쓴다(iOS와 같은 동작). 다른 방식은 쓰지 않는다. 변경할 때도 `setObfuscatedAccountId`를 넣는다.
  - 응답 202 `subscription_pending`(결제 대기), 202 `subscription_change_scheduled`(다음 갱신 때 바뀜), 409 `subscription_not_current`(플랜 변경 전의 옛 토큰)는 실패가 아니다. 오류 문구를 띄우지 않고 잔액만 다시 읽는다.
  - `monthly_credit_granted: false`여도 정상일 수 있다(같은 기간 재확인, 잔액을 유지한 플랜 변경).
- **가입 보너스:** `link` 응답이 `decision: 'linked'`인데 `signupBonusGranted` 필드가 없으면, 같은 idempotency key로 `link`를 한 번 더 부른다.
- **평생권:** 서버가 필요 없다(iOS와 같은 방식). Play Billing에서 구매 확인(acknowledge)과 보유 확인을 한다.
- **교정:** `correct`에 `language`를 보낸다. 앱 언어가 en이나 ja일 때만 보낸다.
- **번역:** `translate`의 `pronunciation_ko`는 한국어 사용자용 한글 발음이다. 앱 언어가 한국어가 아니면 화면에 보여주지 않는다.
- **서버 오류 문구:** 서버의 `message`(예: "킹보드 앱을 열고 '지갑 연결'...")는 한국어다. 해외 앱은 `error` 코드를 보고 앱 안의 번역 문구를 보여준다.
