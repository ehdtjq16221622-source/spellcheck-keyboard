import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAX_INVITES = 5;
const INVITER_REWARD = 100;
const INVITEE_REWARD = 100;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (value) => CODE_ALPHABET[value % CODE_ALPHABET.length]).join("");
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function requireAccountToken(supabase: SupabaseClient, req: Request) {
  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) throw new Error("LOGIN_REQUIRED");
  const tokenHash = await sha256(token);
  const { data, error } = await supabase
    .from("account_api_tokens")
    .select("owner_id")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("LOGIN_REQUIRED");
  await supabase
    .from("account_api_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("owner_id", data.owner_id);
  return String(data.owner_id);
}

async function getOrCreateCode(supabase: SupabaseClient, ownerId: string) {
  const { data: existing, error: existingError } = await supabase
    .from("referral_codes")
    .select("code")
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing?.code) return String(existing.code);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = makeCode();
    const { data, error } = await supabase
      .from("referral_codes")
      .insert({ owner_id: ownerId, code })
      .select("code")
      .single();
    if (!error && data?.code) return String(data.code);
    if (error?.code !== "23505") throw error;

    const { data: raced } = await supabase
      .from("referral_codes")
      .select("code")
      .eq("owner_id", ownerId)
      .maybeSingle();
    if (raced?.code) return String(raced.code);
  }
  throw new Error("CODE_GENERATION_FAILED");
}

function readableError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes("LOGIN_REQUIRED")) return ["Apple 로그인 후 이용할 수 있어요.", 401] as const;
  if (raw.includes("INVALID_CODE")) return ["초대 코드를 다시 확인해주세요.", 400] as const;
  if (raw.includes("SELF_REFERRAL")) return ["내 초대 코드는 등록할 수 없어요.", 400] as const;
  if (raw.includes("INVITE_LIMIT_REACHED")) return ["이 초대 코드는 보상 가능한 5명을 모두 채웠어요.", 409] as const;
  if (raw.includes("AI_USAGE_NOT_FOUND")) return ["첫 AI 기능 사용을 확인한 뒤 보상이 지급돼요.", 409] as const;
  console.error("[referral]", error);
  return ["초대 정보를 처리하지 못했어요. 잠시 후 다시 시도해주세요.", 500] as const;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const body = await req.json();
    const action = body?.action;
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const accountId = await requireAccountToken(supabase, req);

    if (action === "status") {
      const code = await getOrCreateCode(supabase, accountId);
      const [{ count, error: countError }, { data: registration, error: registrationError }] = await Promise.all([
        supabase
          .from("referrals")
          .select("id", { count: "exact", head: true })
          .eq("inviter_id", accountId)
          .eq("status", "completed"),
        supabase
          .from("referrals")
          .select("status, referral_code")
          .eq("invitee_id", accountId)
          .maybeSingle(),
      ]);
      if (countError) throw countError;
      if (registrationError) throw registrationError;
      return json({
        code,
        completed_invites: count ?? 0,
        max_invites: MAX_INVITES,
        inviter_reward: INVITER_REWARD,
        invitee_reward: INVITEE_REWARD,
        registered: Boolean(registration),
        registration_status: registration?.status ?? null,
      });
    }

    if (action === "redeem") {
      const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
      if (!code) return json({ error: "초대 코드를 입력해주세요." }, 400);
      const { data, error } = await supabase.rpc("register_referral", {
        p_invitee_id: accountId,
        p_code: code,
      });
      if (error) throw error;
      const result = Array.isArray(data) ? data[0] : data;
      return json({ ...result, message: result?.already_registered ? "이미 초대 코드가 등록되어 있어요." : "초대 코드가 등록됐어요." });
    }

    if (action === "complete") {
      const requestId = typeof body.requestId === "string" && body.requestId
        ? body.requestId
        : crypto.randomUUID();
      const { data, error } = await supabase.rpc("complete_referral", {
        p_invitee_id: accountId,
        p_request_id: requestId,
      });
      if (error) throw error;
      const result = Array.isArray(data) ? data[0] : data;
      return json(result ?? { applied: false });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (error) {
    const [message, status] = readableError(error);
    return json({ error: message }, status);
  }
});

