// supabase/functions/_shared/referrals.ts

// Minimal shared helpers for referral system.

export function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function getClientIp(req: Request): string | null {
  // Supabase Edge may forward IP via x-forwarded-for.
  const xff = req.headers.get("x-forwarded-for") || req.headers.get("X-Forwarded-For");
  if (!xff) return null;
  // First IP in the chain.
  const ip = xff.split(",")[0]?.trim();
  return ip || null;
}

export async function awardReferralPassive(opts: {
  supabase: any;
  referredUserId: string;
  honeyEarned: number;
  sourceIdempotencyKey: string;
}): Promise<void> {
  const { supabase, referredUserId, honeyEarned, sourceIdempotencyKey } = opts;
  if (!honeyEarned || honeyEarned <= 0) return;

  // Fetch referred user's referrer_id.
  const { data: referred, error: reErr } = await supabase
    .from("users")
    .select("id, referrer_id")
    .eq("id", referredUserId)
    .maybeSingle();
  if (reErr) throw reErr;
  if (!referred?.referrer_id) return;

  const now = new Date();
  const today = dateStr(now);

  // Fetch referral row.
  const { data: refRow, error: rrErr } = await supabase
    .from("referrals")
    .select("status, fraud_flag, activated_at, referred_total_honey_earned, referrer_passive_earned")
    .eq("referrer_id", referred.referrer_id)
    .eq("referred_id", referredUserId)
    .maybeSingle();
  if (rrErr) throw rrErr;
  if (!refRow) return;
  if (refRow.fraud_flag) {
    // Still track total earned by referred.
    await supabase.from("referrals").update({
      referred_total_honey_earned: Number(refRow.referred_total_honey_earned || 0) + honeyEarned,
    }).eq("referrer_id", referred.referrer_id).eq("referred_id", referredUserId);
    return;
  }

  // Only from activated + active within 48h since activation.
  if (refRow.status !== "activated") {
    // track total earned even before activation
    await supabase.from("referrals").update({
      referred_total_honey_earned: Number(refRow.referred_total_honey_earned || 0) + honeyEarned,
    }).eq("referrer_id", referred.referrer_id).eq("referred_id", referredUserId);
    return;
  }
  if (refRow.activated_at) {
    const actMs = new Date(refRow.activated_at).getTime();
    if (now.getTime() - actMs > 48 * 60 * 60 * 1000) {
      // Outside 48h window: only track total.
      await supabase.from("referrals").update({
        referred_total_honey_earned: Number(refRow.referred_total_honey_earned || 0) + honeyEarned,
      }).eq("referrer_id", referred.referrer_id).eq("referred_id", referredUserId);
      return;
    }
  }

  // Fetch referrer for daily cap.
  const { data: referrer, error: rfErr } = await supabase
    .from("users")
    .select("id, honey, referral_honey_earned, referral_income_today, referral_income_today_date")
    .eq("id", referred.referrer_id)
    .maybeSingle();
  if (rfErr) throw rfErr;
  if (!referrer) return;

  let incomeToday = Number(referrer.referral_income_today || 0);
  const incomeDate = (referrer.referral_income_today_date || today).toString();
  if (incomeDate !== today) incomeToday = 0;

  const cap = 5000;
  const remaining = Math.max(0, cap - incomeToday);
  const raw = honeyEarned * 0.10;
  const payout = Math.min(raw, remaining);

  // Always track referred earned.
  await supabase.from("referrals").update({
    referred_total_honey_earned: Number(refRow.referred_total_honey_earned || 0) + honeyEarned,
    referrer_passive_earned: Number(refRow.referrer_passive_earned || 0) + payout,
  }).eq("referrer_id", referred.referrer_id).eq("referred_id", referredUserId);

  if (payout <= 0) {
    // Still keep date fresh.
    await supabase.from("users").update({
      referral_income_today: incomeToday,
      referral_income_today_date: today,
    }).eq("id", referrer.id);
    return;
  }

  await supabase.from("users").update({
    honey: Number(referrer.honey || 0) + payout,
    referral_honey_earned: Number(referrer.referral_honey_earned || 0) + payout,
    referral_income_today: incomeToday + payout,
    referral_income_today_date: today,
  }).eq("id", referrer.id);

  await supabase.from("transactions").insert({
    user_id: referrer.id,
    type: "referral_passive",
    honey_delta: payout,
    idempotency_key: `ref_passive_${referredUserId}_${sourceIdempotencyKey}`,
  });
}

export async function processReferralActivation(opts: {
  supabase: any;
  referredUserId: string;
  referredRpAfter: number;
}): Promise<void> {
  const { supabase, referredUserId, referredRpAfter } = opts;
  if ((referredRpAfter || 0) < 200) return;

  const { data: referred, error: reErr } = await supabase
    .from("users")
    .select("id, referrer_id")
    .eq("id", referredUserId)
    .maybeSingle();
  if (reErr) throw reErr;
  if (!referred?.referrer_id) return;

  const { data: refRow, error: rrErr } = await supabase
    .from("referrals")
    .select("status, activation_reward_claimed")
    .eq("referrer_id", referred.referrer_id)
    .eq("referred_id", referredUserId)
    .maybeSingle();
  if (rrErr) throw rrErr;
  if (!refRow) return;
  if (refRow.status === "activated" && refRow.activation_reward_claimed) return;

  // Update referral row.
  await supabase.from("referrals").update({
    status: "activated",
    activated_at: new Date().toISOString(),
    activation_reward_claimed: true,
  }).eq("referrer_id", referred.referrer_id).eq("referred_id", referredUserId);

  // Pay activation reward to referrer.
  const { data: referrer, error: rfErr } = await supabase
    .from("users")
    .select("id, honey, amber, referral_activated_count")
    .eq("id", referred.referrer_id)
    .maybeSingle();
  if (rfErr) throw rfErr;
  if (!referrer) return;

  await supabase.from("users").update({
    honey: Number(referrer.honey || 0) + 500,
    amber: Number(referrer.amber || 0) + 5,
    referral_activated_count: Number(referrer.referral_activated_count || 0) + 1,
  }).eq("id", referrer.id);

  await supabase.from("transactions").insert({
    user_id: referrer.id,
    type: "referral_activation_reward",
    honey_delta: 500,
    amber_delta: 5,
    idempotency_key: `ref_activation_${referredUserId}`,
  });
}
