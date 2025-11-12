// src\app\api\auth\session\route.ts

import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";

export async function GET() {
  const supabase = await getSupabaseServerClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json(
      { error: error?.message ?? "Auth session missing!", user: null },
      { status: 401 }
    );
  }

  // 🔹 Проверяем и создаём профиль, если его нет
  const { data: profile, error: selectError } = await supabase
    .from("profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!profile) {
    const { error: insertError } = await supabase
      .from("profiles")
      .insert({
        user_id: user.id,
        budget: null,
        goals: null,
        family_data: null,
      });

    if (insertError) {
      console.error("Не удалось создать профиль:", insertError.message);
    }
  }

  return NextResponse.json({ user }, { status: 200 });
}
