// src\app\types.ts

import { z } from "zod";

const memberSchema = z.object({
  name: z.string().min(1).describe("Family member name"),
  age: z.number().int().min(0).nullable().optional(),
  weight: z.number().int().min(0).nullable().optional(),
  likes: z.array(z.string()).default([]),
  dislikes: z.array(z.string()).default([]),
  allergies: z.array(z.string()).default([]),
});

export const updateOperationSchema = z.object({
  name: z.string().optional(),
  resolved_names: z.array(z.string()).default([]),
  applies_to_family: z.boolean().default(false),
  target_scope: z.enum(["family", "self", "named", "unknown"]),

  // списковые операции
  add_allergies: z.array(z.string()).default([]),
  add_likes: z.array(z.string()).default([]),
  add_dislikes: z.array(z.string()).default([]),
  remove_allergies: z.array(z.string()).default([]),
  remove_likes: z.array(z.string()).default([]),
  remove_dislikes: z.array(z.string()).default([]),

  // 🔥 новые поля — чтобы модель могла прислать возраст/вес прямо в апдейте
  age: z.number().int().min(0).nullable().optional(),
  weight: z.number().int().min(0).nullable().optional(),
});

export const intentSchema = z
  .object({
    family_members: z.array(memberSchema).default([]),
    budget: z.number().int().nullable().optional(),
    goals: z.array(z.string()).optional(),
    updates_per_person: z.array(updateOperationSchema).default([]),
  })
  .strict();

export type IntentPayload = z.infer<typeof intentSchema>;
export type IntentUpdateOperation = z.infer<typeof updateOperationSchema>;

/**
 * RAW-схема для OpenAI
 */
export const intentJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    family_members: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1 },
          age: { type: ["integer", "null"], minimum: 0 },
          weight: { type: ["integer", "null"], minimum: 0 },
          likes: {
            type: "array",
            items: { type: "string" },
            default: [],
          },
          dislikes: {
            type: "array",
            items: { type: "string" },
            default: [],
          },
          allergies: {
            type: "array",
            items: { type: "string" },
            default: [],
          },
        },
        required: ["name", "age", "weight", "likes", "dislikes", "allergies"],
      },
      default: [],
    },
    budget: {
      type: ["integer", "null"],
    },
    goals: {
      type: "array",
      items: { type: "string" },
      default: [],
    },
    updates_per_person: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          resolved_names: {
            type: "array",
            items: { type: "string" },
            default: [],
          },
          applies_to_family: {
            type: "boolean",
            default: false,
          },
          target_scope: {
            type: "string",
            enum: ["family", "self", "named", "unknown"],
          },
          add_allergies: {
            type: "array",
            items: { type: "string" },
            default: [],
          },
          add_likes: {
            type: "array",
            items: { type: "string" },
            default: [],
          },
          add_dislikes: {
            type: "array",
            items: { type: "string" },
            default: [],
          },
          remove_allergies: {
            type: "array",
            items: { type: "string" },
            default: [],
          },
          remove_likes: {
            type: "array",
            items: { type: "string" },
            default: [],
          },
          remove_dislikes: {
            type: "array",
            items: { type: "string" },
            default: [],
          },

          // 👇 добавили в JSON Schema тоже
          age: { type: ["integer", "null"] },
          weight: { type: ["integer", "null"] },
        },
        required: [
          "name",
          "resolved_names",
          "applies_to_family",
          "target_scope",
          "add_allergies",
          "add_likes",
          "add_dislikes",
          "remove_allergies",
          "remove_likes",
          "remove_dislikes",
          // 👇 и эти тоже, чтобы OpenAI точно присылал
          "age",
          "weight",
        ],
      },
      default: [],
    },
  },
  required: ["family_members", "budget", "goals", "updates_per_person"],
};

/**
 * mixed-обёртка
 */
export const mixedIntentJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: {
      type: "string",
      description:
        "Текстовый, человеко-понятный ответ ассистента на русском языке.",
    },
    intent: intentJsonSchema,
  },
  required: ["message", "intent"],
};

export const mixedIntentSchema = z.object({
  message: z.string(),
  intent: intentSchema,
});

export type MixedIntentPayload = z.infer<typeof mixedIntentSchema>;
