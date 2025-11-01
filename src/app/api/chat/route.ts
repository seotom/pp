import { NextResponse } from "next/server";
import { z } from "zod";
import { parseUserMessage } from "@/modules/parser";
import { getSupabaseServerClient } from "@/lib/supabase-server";

const requestSchema = z.object({
  message: z.string().min(1, "message must not be empty"),
});

export async function POST(request: Request) {
  try {
    const supabase = await getSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { error: "Требуется вход через Google." },
        { status: 401 },
      );
    }

    const body = await request.json();
    const { message } = requestSchema.parse(body);

    // Найти профиль пользователя
    const identifier = user.email ?? user.id;
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id")
      .eq("user_id", identifier)
      .single();

    if (profileError || !profile) {
      return NextResponse.json(
        { error: "Профиль не найден." },
        { status: 404 },
      );
    }


    // Сохраняем сообщение пользователя
    await supabase.from("chat_messages").insert({
      profile_id: profile.id,
      role: "user",
      content: message,
    });

    // Анализируем и получаем ответ
    const result = await parseUserMessage(message, identifier);

    // Сохраняем ответ ассистента
    await supabase.from("chat_messages").insert({
      profile_id: profile.id,
      role: "assistant",
      content: result.content,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Некорректные данные запроса", details: error.flatten() },
        { status: 400 },
      );
    }

    console.error("Unhandled /api/chat error", error);
    return NextResponse.json(
      { error: "Не удалось обработать запрос." },
      { status: 500 },
    );
  }
}
