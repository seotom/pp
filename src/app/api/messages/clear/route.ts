import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export async function DELETE() {
  try {
    const supabase = await getSupabaseServerClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { error: "Требуется авторизация." },
        { status: 401 },
      );
    }

    const identifier = user.email ?? user.id;

    // 🔹 Находим профиль
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id")
      .eq("user_id", identifier)
      .maybeSingle();

    if (profileError || !profile) {
      return NextResponse.json(
        { error: "Профиль не найден." },
        { status: 404 },
      );
    }

    // 🔹 Удаляем сообщения
    await supabase.from("chat_messages").delete().eq("profile_id", profile.id);

    // 🔹 Удаляем членов семьи
    await supabase.from("family_members").delete().eq("profile_id", profile.id);

    // 🔹 Сбрасываем данные профиля (бюджет, цели, family_data)
    await supabase
      .from("profiles")
      .update({
        budget: null,
        goals: null,
        family_data: null,
      })
      .eq("id", profile.id);

    return NextResponse.json({
      success: true,
      message: "История и связанные данные очищены, профиль сохранён.",
    });
  } catch (error) {
    console.error("DELETE /api/messages/clear error", error);
    return NextResponse.json(
      { error: "Не удалось очистить историю." },
      { status: 500 },
    );
  }
}
