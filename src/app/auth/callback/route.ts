// src\app\auth\callback\route.ts

import { NextResponse } from "next/server";

import { createSupabaseServerClientWithResponse } from "@/lib/supabase-server";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const next = requestUrl.searchParams.get("next") ?? "/";

  const redirectUrl = new URL(next, requestUrl.origin);
  const response = NextResponse.redirect(redirectUrl, { status: 302 });

  if (!code) {
    return response;
  }

  const supabase = await createSupabaseServerClientWithResponse(response);
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const errorUrl = new URL("/", requestUrl.origin);
    errorUrl.searchParams.set("auth_error", error.message);
    return NextResponse.redirect(errorUrl, { status: 302 });
  }

  return response;
}
