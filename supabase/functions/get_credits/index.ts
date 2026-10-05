import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveCreditWallet, WalletAccessError } from "../_shared/wallet_auth.ts";

const NEW_REWARDED_AD_CREDITS = 100;
const LEGACY_REWARDED_AD_CREDITS = 200;
const REWARDED_AD_CREDITS_CUTOFF = Date.parse("2026-09-19T15:00:00.000Z"); // 2026-09-20 00:00 KST
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Expose-Headers": "X-Kingboard-Diagnostic-ID",
};

async function walletFingerprint(walletId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(walletId));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function errorCode(error: unknown): string {
  if (!(error instanceof WalletAccessError)) return "internal_error";
  if (error.message.includes("기기 지갑을 찾을 수 없어요")) return "wallet_row_missing";
  if (error.message.includes("최신 버전으로 업데이트")) return "client_update_required";
  if (error.status === 401) return "wallet_session_rejected";
  if (error.status === 409) return "wallet_mismatch";
  return "wallet_access_rejected";
}

function jsonResponse(body: Record<string, unknown>, status: number, diagnosticId: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "X-Kingboard-Diagnostic-ID": diagnosticId,
    },
  });
}

type CreditRow = {
  device_id: string;
  apple_user_id: string | null;
  free_credits: number;
  paid_credits: number;
  subscription_credits: number;
  created_at: string;
};

function rewardedAdCreditsFor(createdAt: string | null | undefined) {
  const installedAt = Date.parse(createdAt ?? "");
  if (!Number.isFinite(installedAt)) return NEW_REWARDED_AD_CREDITS;
  return installedAt >= REWARDED_AD_CREDITS_CUTOFF
    ? NEW_REWARDED_AD_CREDITS
    : LEGACY_REWARDED_AD_CREDITS;
}

async function requireCreditRow(supabase: SupabaseClient, deviceId: string): Promise<CreditRow> {
  const { data, error } = await supabase
    .from("device_credits")
    .select("device_id, apple_user_id, free_credits, paid_credits, subscription_credits, created_at")
    .eq("device_id", deviceId)
    .maybeSingle();
  if (error) throw error;
  if (data) return data as CreditRow;
  throw new WalletAccessError(
    "기기 지갑을 찾을 수 없어요. 앱을 최신 버전으로 업데이트한 뒤 다시 시도해 주세요.",
    409,
  );
}

async function walletSnapshot(supabase: SupabaseClient, requestedId: string) {
  const requested = await requireCreditRow(supabase, requestedId);
  return {
    freeCredits: requested.free_credits,
    paidCredits: requested.paid_credits + requested.subscription_credits,
    rewardedAdCredits: rewardedAdCreditsFor(requested.created_at),
  };
}

// Preserve v13 display semantics for existing, unprotected legacy wallets.
// Unlike v13, a balance read must never create a new bonus-bearing wallet.
async function legacySnapshot(supabase: SupabaseClient, requestedId: string) {
  const requested = await requireCreditRow(supabase, requestedId);
  const appleId = requested.apple_user_id || requestedId;
  const { data, error } = await supabase.from("device_credits")
    .select("device_id, apple_user_id, free_credits, paid_credits, subscription_credits, created_at")
    .eq("apple_user_id", appleId);
  if (error) throw error;
  const rows = data as CreditRow[];
  // Legacy access to an independent row must never expose the protected V2 pot.
  if (requested.apple_user_id === null && rows.some((row) => row.device_id.startsWith('v2:'))) {
    return walletSnapshot(supabase, requestedId);
  }
  if (!rows.length) return {
    freeCredits: requested.free_credits,
    paidCredits: requested.paid_credits + requested.subscription_credits,
    rewardedAdCredits: rewardedAdCreditsFor(requested.created_at),
  };
  const canonical = requestedId === appleId
    ? requested : await requireCreditRow(supabase, appleId);
  return {
    freeCredits: Math.max(...rows.map((row) => Math.max(0, row.free_credits))),
    paidCredits: rows.filter((row) => row.device_id !== canonical.device_id)
      .reduce((sum, row) => sum + Math.max(0, row.paid_credits + row.subscription_credits),
        Math.max(0, canonical.paid_credits + canonical.subscription_credits)),
    rewardedAdCredits: rewardedAdCreditsFor(requested.created_at),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const diagnosticId = crypto.randomUUID();
  let failureStage = "request_parse";
  let requestedWalletFingerprint: string | undefined;
  let canonicalWalletFingerprint: string | undefined;
  try {
    const { deviceId } = await req.json();
    if (typeof deviceId !== "string" || !deviceId) {
      return jsonResponse({
        error: "Missing deviceId.",
        error_code: "missing_wallet_id",
        diagnostic_id: diagnosticId,
        failure_stage: "request_validation",
      }, 400, diagnosticId);
    }
    requestedWalletFingerprint = await walletFingerprint(deviceId);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    failureStage = "wallet_resolution";
    const wallet = await resolveCreditWallet(req, supabase, deviceId);
    canonicalWalletFingerprint = await walletFingerprint(wallet.walletId);
    // Authenticated clients use only the wallet that consumeAIUsage debits.
    // Protection is enforced before the legacy compatibility branch.
    failureStage = wallet.authenticated ? "credit_snapshot" : "legacy_snapshot";
    const credits = wallet.authenticated
      ? await walletSnapshot(supabase, wallet.walletId)
      : await legacySnapshot(supabase, wallet.walletId);
    console.info(JSON.stringify({
      event: "get_credits_completed",
      diagnostic_id: diagnosticId,
      requested_wallet_fingerprint: requestedWalletFingerprint,
      canonical_wallet_fingerprint: canonicalWalletFingerprint,
    }));
    return jsonResponse({
      free_credits_remaining: credits.freeCredits,
      paid_credits_remaining: credits.paidCredits,
      credits_remaining: credits.freeCredits + credits.paidCredits,
      rewarded_ad_credits: credits.rewardedAdCredits ?? NEW_REWARDED_AD_CREDITS,
      diagnostic_id: diagnosticId,
    }, 200, diagnosticId);
  } catch (error) {
    const code = errorCode(error);
    console.error(JSON.stringify({
      event: "get_credits_failed",
      diagnostic_id: diagnosticId,
      failure_stage: failureStage,
      error_code: code,
      requested_wallet_fingerprint: requestedWalletFingerprint,
      canonical_wallet_fingerprint: canonicalWalletFingerprint,
    }));
    return jsonResponse({
      error: error instanceof WalletAccessError ? error.message : "Unable to load credits.",
      error_code: code,
      diagnostic_id: diagnosticId,
      failure_stage: failureStage,
    }, error instanceof WalletAccessError ? error.status : 500, diagnosticId);
  }
});
