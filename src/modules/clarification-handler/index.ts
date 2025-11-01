import { getSupabaseServiceRoleClient } from "@/lib/supabase";
import type {
  ClarificationState,
  PendingClarification,
  ResolvedIntent,
} from "@/modules/parser/types";
import type { Json } from "@/types/database";

import type { Database } from "@/types/database";
type Profile = Database["public"]["Tables"]["profiles"]["Row"];

type ClarificationContext = {
  userId: string;
  message: string;
  intent: ResolvedIntent;
};

type ClarificationResult = {
  intent: ResolvedIntent;
  requiresClarification?: boolean;
  clarificationContent?: string;
};

function buildClarificationContent(
  clarifications: PendingClarification[],
): string {
  const items = clarifications.map((clarification, index) => {
    const prefix = `${index + 1}.`;
    const target =
      clarification.requestedName ??
      (clarification.target_scope === "self"
        ? 'which specific family member is meant by "I"'
        : "which family member should be updated");

    return `${prefix} Please specify ${target}: ${clarification.message}`;
  });

  return [
    "More information is required before applying your request:",
    ...items,
    "Please reply with the missing details so I can continue.",
  ].join("\n");
}

export async function handleClarification(
  context: ClarificationContext,
): Promise<ClarificationResult> {
  const supabase = getSupabaseServiceRoleClient();
  const { intent, message } = context;

  const currentFamilyData =
    (intent.profile.family_data as ClarificationState | null) ?? {};

  const hasClarifications = intent.clarifications.length > 0;
  const updatedFamilyData: ClarificationState = { ...currentFamilyData };

  if (hasClarifications) {
    updatedFamilyData.pending_clarification = {
      message,
      timestamp: new Date().toISOString(),
      updates_per_person: intent.clarifications,
    };
  } else if (updatedFamilyData.pending_clarification) {
    delete updatedFamilyData.pending_clarification;
  }

  const familyDataToStore =
    Object.keys(updatedFamilyData).length > 0
      ? (updatedFamilyData as Json)
      : null;

  const { data: updatedProfile, error } = await supabase
    .from("profiles")
    .update({
      family_data: familyDataToStore,
    })
    .eq("id", intent.profile.id)
    .select()
    .single();

  if (error || !updatedProfile) {
    throw error ?? new Error("Failed to update profile.family_data.");
  }

  const nextIntent: ResolvedIntent = {
    ...intent,
    profile: { ...(intent.profile as Profile), ...updatedProfile },
  };

  if (hasClarifications) {
    return {
      intent: nextIntent,
      requiresClarification: true,
      clarificationContent: buildClarificationContent(intent.clarifications),
    };
  }

  return {
    intent: nextIntent,
  };
}

export type { ClarificationContext, ClarificationResult };
