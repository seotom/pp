// src\app\api\auth\sign-out\route.ts

import { NextResponse } from "next/server";

import { createSupabaseServerClientWithResponse } from "@/lib/supabase-server";

export async function POST() {
  const response = NextResponse.json({ success: true });
  const supabase = await createSupabaseServerClientWithResponse(response);

  const { error } = await supabase.auth.signOut();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return response;
}
