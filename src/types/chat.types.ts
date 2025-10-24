// src/types/chat.types.ts

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export interface SupabaseProfile {
  id: number;
  budget: number | null;
  goals: string | null;
  family_data: Record<string, any> | null;
}

export interface SupabaseFamilyMember {
  name: string | null;
  age: number | null;
  weight: number | null;
  allergies: string[] | null;
  dislikes: string[] | null;
  likes: string[] | null;
}

export interface UserData {
  profile: SupabaseProfile;
  family: SupabaseFamilyMember[];
}