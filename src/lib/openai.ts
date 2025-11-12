// src\lib\openai.ts

import OpenAI from "openai";

import { getEnv } from "@/lib/env";

let client: OpenAI | undefined;

export function getOpenAIClient(): OpenAI {
  if (!client) {
    const env = getEnv();
    client = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
    });
  }

  return client;
}
