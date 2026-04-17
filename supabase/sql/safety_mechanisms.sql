-- =============================================================
-- 킹보드 서버 안전장치 마이그레이션
-- Supabase SQL Editor에서 한 번 실행
-- =============================================================

-- -------------------------------------------------------------
-- 1. deduct_credits: atomic credit deduction (race-condition safe)
--    free 먼저 소진 → 부족분은 paid에서 차감
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION deduct_credits(
  p_device_id TEXT,
  p_cost      INT
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_free INT;
  v_paid INT;
BEGIN
  UPDATE device_credits
  SET
    free_credits = GREATEST(0, free_credits - p_cost),
    paid_credits = GREATEST(0, paid_credits - GREATEST(0, p_cost - free_credits)),
    updated_at   = NOW()
  WHERE device_id = p_device_id
    AND (free_credits + paid_credits) >= p_cost
  RETURNING free_credits, paid_credits INTO v_free, v_paid;

  IF NOT FOUND THEN
    -- 잔액 부족이거나 row 없음
    SELECT
      COALESCE(free_credits, 0),
      COALESCE(paid_credits, 0)
    INTO v_free, v_paid
    FROM device_credits
    WHERE device_id = p_device_id;

    RETURN json_build_object(
      'ok',           false,
      'free_credits', COALESCE(v_free, 0),
      'paid_credits', COALESCE(v_paid, 0),
      'remaining',    COALESCE(v_free, 0) + COALESCE(v_paid, 0)
    );
  END IF;

  RETURN json_build_object(
    'ok',           true,
    'free_credits', v_free,
    'paid_credits', v_paid,
    'remaining',    v_free + v_paid
  );
END;
$$;

-- -------------------------------------------------------------
-- 2. reward_ad_log: 광고 보상 기록 (일 5회 한도 체크용)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reward_ad_log (
  id           BIGSERIAL PRIMARY KEY,
  device_id    TEXT        NOT NULL,
  rewarded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  credits_given INT        NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reward_ad_log_device_time
  ON reward_ad_log (device_id, rewarded_at DESC);

-- -------------------------------------------------------------
-- 3. coupon_redemptions: 쿠폰 사용 기록 + 기기당 재사용 방지
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id            BIGSERIAL PRIMARY KEY,
  device_id     TEXT        NOT NULL,
  coupon_code   TEXT        NOT NULL,
  redeemed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  credits_given INT         NOT NULL,
  UNIQUE (device_id, coupon_code)
);

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_device
  ON coupon_redemptions (device_id);

-- -------------------------------------------------------------
-- 4. grant_paid_credits: atomic paid credit grant
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION grant_paid_credits(
  p_device_id TEXT,
  p_amount    INT
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_free INT;
  v_paid INT;
BEGIN
  INSERT INTO device_credits (device_id, free_credits, paid_credits, last_reset_date)
  VALUES (p_device_id, 50, 0, CURRENT_DATE)
  ON CONFLICT (device_id) DO NOTHING;

  UPDATE device_credits
  SET
    paid_credits = paid_credits + p_amount,
    updated_at   = NOW()
  WHERE device_id = p_device_id
  RETURNING free_credits, paid_credits INTO v_free, v_paid;

  RETURN json_build_object(
    'free_credits', v_free,
    'paid_credits', v_paid,
    'remaining',    v_free + v_paid
  );
END;
$$;

-- -------------------------------------------------------------
-- 5. request_rate_limits: 함수별 간단한 rate limit 버킷
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS request_rate_limits (
  bucket_key         TEXT PRIMARY KEY,
  request_count      INT         NOT NULL DEFAULT 0,
  window_started_at  TIMESTAMPTZ NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
