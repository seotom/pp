// src\lib\supabase-browser.ts

import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/types/database";

let browserClient:
  | ReturnType<typeof createBrowserClient<Database>>
  | null = null;

export function getSupabaseBrowserClient() {
  if (typeof window === "undefined") {
    return null;
  }

  if (!browserClient) {
    browserClient = createBrowserClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""
    );
  }

  return browserClient;
}
