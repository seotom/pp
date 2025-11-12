// src\app\api\auth\callback\route.ts

import { NextResponse } from "next/server";
import { createSupabaseServerClientWithResponse } from "@/lib/supabase-server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  // куда вернём пользователя после колбэка
  const redirectTo = new URL("/", request.url);
  const response = NextResponse.redirect(redirectTo);

  if (!code) {
    // если пришли без кода — просто домой
    return response;
  }

  const supabase = await createSupabaseServerClientWithResponse(response);

  // ключевая операция: обмен кода на сессию + запись куки сервером
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    // при ошибке всё равно редиректим на главную (можешь добавить query ?authError=1)
    return response;
  }

  return response;
}
