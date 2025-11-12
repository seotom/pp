// src\lib\supabase.ts

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getEnv } from "@/lib/env";
import type { Database } from "@/types/database";

let supabaseServiceRoleClient: SupabaseClient<Database> | undefined;

export function getSupabaseServiceRoleClient(): SupabaseClient<Database> {
  if (!supabaseServiceRoleClient) {
    const env = getEnv();
    supabaseServiceRoleClient = createClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY
    );
  }

  return supabaseServiceRoleClient;
}

export function getSupabaseAnonClient(): SupabaseClient<Database> {
  const env = getEnv();

  return createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}
