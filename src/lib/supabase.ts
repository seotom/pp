// src\lib\supabase.ts
// Назначение: Утилиты для работы с Supabase

import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Server-side Supabase client. Uses service role if available, otherwise anon key.
export function getSupabaseServer() {
  // Singleton-клиент, чтобы не логировать "supabase init" многократно
  const globalAny = globalThis as any;
  if (globalAny.__supabase_server_client) {
    return globalAny.__supabase_server_client as SupabaseClient;
  }

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url) throw new Error("Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL env");
  const key = serviceKey || anonKey;
  if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY env");
  const keyType = serviceKey ? "service_role" : "anon";
  if (!globalAny.__supabase_server_client_logged) {
    console.log("supabase init", { keyType, url: String(url).slice(0, 32) + "..." });
    globalAny.__supabase_server_client_logged = true;
  }
  const client = createClient(url, key, { auth: { persistSession: false } });
  globalAny.__supabase_server_client = client;
  return client;
}

export type ProfileRow = {
  id: number;
  user_id: string;
  family_data: any | null;
  budget: number | null;
  goals: string | null;
  created_at: string;
};