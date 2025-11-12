// src\modules\intent-analyzer\index.ts

import type { PromptPayload } from "@/modules/prompt-builder";
import {
  mixedIntentSchema,
  type MixedIntentPayload,
} from "@/modules/intent-analyzer/types";
import { getOpenAIClient } from "@/lib/openai";

type AnalyzeIntentParams = PromptPayload;

export async function analyzeIntent(
  prompt: AnalyzeIntentParams,
): Promise<MixedIntentPayload> {
  const client = getOpenAIClient();

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: prompt.messages,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "mixed_intent_schema",
        schema: prompt.jsonSchema,
        strict: true,
      },
    },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI returned an empty response.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Failed to parse JSON returned by OpenAI: ${(error as Error).message}`,
    );
  }

  // тут мы уже ждём { message, intent: {...} }
  return mixedIntentSchema.parse(parsed);
}

export type { AnalyzeIntentParams };
