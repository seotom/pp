import type { IntentPayload, IntentUpdateOperation } from "@/modules/intent-analyzer/types";
import type { FamilyMemberRow, ProfileRow } from "@/types/database";

export type ParsedIntent = IntentPayload;
export type ParsedUpdateOperation = IntentUpdateOperation;

export type FamilyMemberRecord = FamilyMemberRow;
export type ProfileRecord = ProfileRow;

export type ResolvedMemberUpdate = {
  memberIds: number[];
  scope: "family" | "member";
  requestedName?: string;
  operations: Pick<
    IntentUpdateOperation,
    | "add_allergies"
    | "add_dislikes"
    | "add_likes"
    | "remove_allergies"
    | "remove_dislikes"
    | "remove_likes"
  >;
};

export type PendingClarification = {
  message: string;
  requestedName?: string;
  target_scope: IntentUpdateOperation["target_scope"];
  operations: ResolvedMemberUpdate["operations"];
};

export type ResolvedIntent = {
  profile: ProfileRecord;
  familyMembers: FamilyMemberRecord[];
  newMembers: ParsedIntent["family_members"];
  updates: ResolvedMemberUpdate[];
  clarifications: PendingClarification[];
  budget: number | null | undefined;
  goals?: string[];
};

export type ClarificationState = {
  pending_clarification?: {
    message: string;
    timestamp: string;
    updates_per_person: PendingClarification[];
  };
  [key: string]: unknown;
};
