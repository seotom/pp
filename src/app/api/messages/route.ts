import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export async function GET() {
  try {
    const supabase = await getSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { error: "Требуется авторизация через Google." },
        { status: 401 },
      );
    }

    const identifier = user.email ?? user.id;
    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("user_id", identifier)
      .single();

    if (!profile) {
      return NextResponse.json({ messages: [] });
    }

    const { data: messages, error } = await supabase
      .from("chat_messages")
      .select("id, role, content, created_at")
      .eq("profile_id", profile.id)
      .order("created_at", { ascending: true });

    if (error) throw error;

    return NextResponse.json({ messages });
  } catch (error) {
    console.error("GET /api/messages error", error);
    return NextResponse.json(
      { error: "Не удалось загрузить историю сообщений." },
      { status: 500 },
    );
  }
}
