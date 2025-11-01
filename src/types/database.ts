export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: number;
          user_id: string;
          budget: number | null;
          goals: string | null;
          family_data: Json | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: number;
          user_id: string;
          budget?: number | null;
          goals?: string | null;
          family_data?: Json | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: number;
          user_id?: string;
          budget?: number | null;
          goals?: string | null;
          family_data?: Json | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      family_members: {
        Row: {
          id: number;
          profile_id: number;
          name: string;
          age: number | null;
          weight: number | null;
          likes: string[] | null;
          dislikes: string[] | null;
          allergies: string[] | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: number;
          profile_id: number;
          name: string;
          age?: number | null;
          weight?: number | null;
          likes?: string[] | null;
          dislikes?: string[] | null;
          allergies?: string[] | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: number;
          profile_id?: number;
          name?: string;
          age?: number | null;
          weight?: number | null;
          likes?: string[] | null;
          dislikes?: string[] | null;
          allergies?: string[] | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "family_members_profile_id_fkey";
            columns: ["profile_id"];
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      chat_messages: {
        Row: {
          id: number;
          profile_id: number;
          role: "user" | "assistant";
          content: string;
          created_at: string;
        };
        Insert: {
          id?: number;
          profile_id: number;
          role: "user" | "assistant";
          content: string;
          created_at?: string;
        };
        Update: {
          id?: number;
          profile_id?: number;
          role?: "user" | "assistant";
          content?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "chat_messages_profile_id_fkey";
            columns: ["profile_id"];
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

export type ProfileRow = Database["public"]["Tables"]["profiles"]["Row"];
export type FamilyMemberRow =
  Database["public"]["Tables"]["family_members"]["Row"];
export type ChatMessageRow =
  Database["public"]["Tables"]["chat_messages"]["Row"];