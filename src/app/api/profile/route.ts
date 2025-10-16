// src\app\api\profile\route.ts

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase";

export const runtime = "nodejs";

// GET /api/profile?user_id=...
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const user_id = url.searchParams.get("user_id");
    if (!user_id) return NextResponse.json({ error: "Missing user_id" }, { status: 400 });
    const supabase = getSupabaseServer();
    const { data, error } = await supabase
      .from("profiles")
      .select("id,user_id,family_data,budget,goals,created_at")
      .eq("user_id", user_id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return NextResponse.json({ profile: data ?? null });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Unknown error" }, { status: 500 });
  }
}

// POST /api/profile  { user_id, family_data?, budget?, goals? }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const user_id: string | undefined = body?.user_id;
    if (!user_id) return NextResponse.json({ error: "Missing user_id" }, { status: 400 });
    const supabase = getSupabaseServer();

    // Читаем текущую запись, чтобы не затирать поля в БД, если их нет в запросе
    const { data: existing } = await supabase
      .from("profiles")
      .select("id,user_id,family_data,budget,goals,created_at")
      .eq("user_id", user_id)
      .limit(1)
      .maybeSingle();

    const hasFamilyData = Object.prototype.hasOwnProperty.call(body, "family_data");
    const hasBudget = Object.prototype.hasOwnProperty.call(body, "budget");
    const hasGoals = Object.prototype.hasOwnProperty.call(body, "goals");

    if (existing) {
      const updatePayload: any = {};
      if (hasFamilyData) updatePayload.family_data = body.family_data;
      if (hasBudget) updatePayload.budget = body.budget;
      if (hasGoals) updatePayload.goals = body.goals;

      if (Object.keys(updatePayload).length === 0) {
        // Нечего обновлять — возвращаем текущий профиль
        return NextResponse.json({ profile: existing });
      }

      const { data, error } = await supabase
        .from("profiles")
        .update(updatePayload)
        .eq("user_id", user_id)
        .select("id,user_id,family_data,budget,goals,created_at")
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return NextResponse.json({ profile: data });
    } else {
      // Вставка новой записи: добавляем только явные поля, без принудительного null
      const insertPayload: any = { user_id };
      if (hasFamilyData) insertPayload.family_data = body.family_data;
      if (hasBudget) insertPayload.budget = body.budget;
      if (hasGoals) insertPayload.goals = body.goals;

      const { data, error } = await supabase
        .from("profiles")
        .insert(insertPayload)
        .select("id,user_id,family_data,budget,goals,created_at")
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return NextResponse.json({ profile: data });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Unknown error" }, { status: 500 });
  }
}

// DELETE /api/profile?user_id=...
// Полное удаление данных пользователя: запись профиля и связанные family_members
export async function DELETE(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const user_id = url.searchParams.get("user_id");
    if (!user_id) return NextResponse.json({ error: "Missing user_id" }, { status: 400 });
    const supabase = getSupabaseServer();

    // Найти профиль по user_id
    const { data: profile, error: readErr } = await supabase
      .from("profiles")
      .select("id")
      .eq("user_id", user_id)
      .limit(1)
      .maybeSingle();
    if (readErr) throw readErr;

    const profileId = (profile as any)?.id as number | undefined;
    if (profileId) {
      // Удалить членов семьи, связанных с профилем
      const { error: fmErr } = await supabase
        .from("family_members")
        .delete()
        .eq("profile_id", profileId);
      if (fmErr) throw fmErr;
      // Удалить сам профиль
      const { error: profErr } = await supabase
        .from("profiles")
        .delete()
        .eq("user_id", user_id);
      if (profErr) throw profErr;
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Unknown error" }, { status: 500 });
  }
}