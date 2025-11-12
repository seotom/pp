// src\modules\canonicalization\index.ts

import type {
  PendingClarification,
  ResolvedIntent,
  ResolvedMemberUpdate,
} from "@/modules/parser/types";

function canon(value: string): string {
  return value.trim().toLowerCase();
}

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list.map(canon)));
}

function canonicaliseUpdate(update: ResolvedMemberUpdate): ResolvedMemberUpdate {
  const normalisedOperations = {
    add_allergies: dedupe(update.operations.add_allergies),
    add_dislikes: dedupe(update.operations.add_dislikes),
    add_likes: dedupe(update.operations.add_likes),
    remove_allergies: dedupe(update.operations.remove_allergies),
    remove_dislikes: dedupe(update.operations.remove_dislikes),
    remove_likes: dedupe(update.operations.remove_likes),
    age: update.operations.age,
    weight: update.operations.weight,
  };

  return {
    ...update,
    operations: normalisedOperations,
  };
}

function canonicaliseClarification(
  clarification: PendingClarification
): PendingClarification {
  return {
    ...clarification,
    operations: {
      add_allergies: dedupe(clarification.operations.add_allergies),
      add_dislikes: dedupe(clarification.operations.add_dislikes),
      add_likes: dedupe(clarification.operations.add_likes),
      remove_allergies: dedupe(clarification.operations.remove_allergies),
      remove_dislikes: dedupe(clarification.operations.remove_dislikes),
      remove_likes: dedupe(clarification.operations.remove_likes),
    },
  };
}

export function canonicalizeFoodItems(intent: ResolvedIntent): ResolvedIntent {
  const canonicalNewMembers = intent.newMembers
  .filter((member) => member.name)
  .map((member) => ({
    ...member,
    name: member.name!.trim(),  // ✅ ! говорит TypeScript, что это гарантированно string
    likes: dedupe(member.likes ?? []),
    dislikes: dedupe(member.dislikes ?? []),
    allergies: dedupe(member.allergies ?? []),
  }));

  return {
    ...intent,
    newMembers: canonicalNewMembers,
    updates: intent.updates.map(canonicaliseUpdate),
    clarifications: intent.clarifications.map(canonicaliseClarification),
  };
}
