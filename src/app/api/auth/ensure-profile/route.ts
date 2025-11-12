// src\app\api\auth\ensure-profile\route.ts

import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function POST() {
  const supabase = await getSupabaseServerClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json({ error: "Пользователь не найден." }, { status: 401 });
  }

  const identifier = user.email ?? user.id;

  // 🔹 Проверяем, есть ли профиль с таким email
  const { data: existingProfile, error: selectError } = await supabase
    .from("profiles")
    .select("id")
    .eq("user_id", identifier)
    .maybeSingle();

  if (selectError) {
    console.error("Ошибка при поиске профиля:", selectError);
    return NextResponse.json({ error: "Ошибка при проверке профиля." }, { status: 500 });
  }

  if (existingProfile) {
    // ✅ Профиль уже есть — просто возвращаем успех
    return NextResponse.json({ success: true, profile_id: existingProfile.id });
  }

  // 🔹 Создаём новый профиль, если нет
  const { data: newProfile, error: insertError } = await supabase
    .from("profiles")
    .insert({
      user_id: identifier,
      budget: null,
      goals: null,
      family_data: null,
    })
    .select("id")
    .single();

  if (insertError) {
    console.error("Ошибка при создании профиля:", insertError);
    return NextResponse.json({ error: "Не удалось создать профиль." }, { status: 500 });
  }

  return NextResponse.json({ success: true, profile_id: newProfile.id });
}
