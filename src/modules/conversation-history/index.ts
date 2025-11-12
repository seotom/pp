// src\modules\conversation-history\index.ts

import { getSupabaseServiceRoleClient } from "@/lib/supabase";

export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
};

async function loadConversationHistory(
  userId: string,
  limit: number = 5
): Promise<ConversationMessage[]> {
  const supabase = getSupabaseServiceRoleClient();

  try {
    // ✅ Сначала получаем profile_id по user_id
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id")
      .eq("user_id", userId)
      .single();

    if (profileError || !profile) {
      console.warn("Profile not found for user:", userId, profileError);
      return [];
    }

    console.log("✅ Found profile_id:", profile.id, "for user:", userId);

    // ✅ Затем загружаем сообщения по profile_id
    const { data, error } = await supabase
      .from("chat_messages")
      .select("role, content, created_at")
      .eq("profile_id", profile.id)
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) {
      console.error("Failed to load conversation history:", error);
      return [];
    }

    if (!data || data.length === 0) {
      console.log("✅ No previous messages found");
      return [];
    }

    console.log("✅ Loaded", data.length, "messages from history");

    return data.map((msg: any) => ({
      role: msg.role as "user" | "assistant",
      content: msg.content,
      timestamp: msg.created_at,
    }));
  } catch (err) {
    console.error("Exception in loadConversationHistory:", err);
    return [];
  }
}

function formatHistoryForPrompt(history: ConversationMessage[]): string {
  if (history.length === 0) {
    return "";
  }

  const formatted = history
    .map((msg) => {
      const role = msg.role === "user" ? "Пользователь" : "Я (AI)";
      return `${role}: ${msg.content}`;
    })
    .join("\n");

  return `📜 ИСТОРИЯ ДИАЛОГА (для контекста):
${formatted}

---`;
}

export { loadConversationHistory, formatHistoryForPrompt };
