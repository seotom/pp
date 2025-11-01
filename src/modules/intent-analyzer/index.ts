import type { PromptPayload } from "@/modules/prompt-builder";
import {
  intentSchema,
  type IntentPayload,
} from "@/modules/intent-analyzer/types";
import { getOpenAIClient } from "@/lib/openai";

type AnalyzeIntentParams = PromptPayload;

export async function analyzeIntent(
  prompt: AnalyzeIntentParams,
): Promise<IntentPayload> {
  const client = getOpenAIClient();

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: prompt.messages,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "intent_schema",
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
    
    console.log(parsed)

  } catch (error) {
    throw new Error(
      `Failed to parse JSON returned by OpenAI: ${(error as Error).message}`,
    );
  }

  return intentSchema.parse(parsed);
}

export type { AnalyzeIntentParams };
