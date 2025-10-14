import type { NutritionProfile } from "@/types/nutrition";

export type Role = "user" | "assistant" | "system";
export interface ChatMessage { role: Role; content: string }
export interface AgentContext { userId?: string; profile?: NutritionProfile }
export interface AgentResult { content: string; data?: any }
export interface Agent { handleChat(messages: ChatMessage[], context: AgentContext): Promise<AgentResult> }