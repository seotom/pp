import OpenAI from "openai";
import { ChatMessage } from "@/agents/core";

export class OpenAIService {
  private client: OpenAI;
  private chatModel: string;

  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.chatModel = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
  }

  async chat(messages: ChatMessage[], system?: string): Promise<string> {
    const msgs = system ? [{ role: "system", content: system }, ...messages] : messages;
    const completion = await this.client.chat.completions.create({
      model: this.chatModel,
      messages: msgs as any,
      temperature: 0.7,
    });
    return completion.choices?.[0]?.message?.content ?? "";
  }

  async extractJson(messages: ChatMessage[], system: string): Promise<any> {
    const msgs = [{ role: "system", content: system }, ...messages] as any;
    const completion = await this.client.chat.completions.create({
      model: this.chatModel,
      messages: msgs,
      temperature: 0,
      response_format: { type: "json_object" },
    });
    const raw = completion.choices?.[0]?.message?.content ?? "{}";
    try {
      return JSON.parse(raw);
    } catch {
      const fenced = raw.trim().match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenced) {
        try { return JSON.parse(fenced[1]); } catch { return {}; }
      }
      return {};
    }
  }
}