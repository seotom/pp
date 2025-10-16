import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(request: NextRequest) {
  try {
    const { item } = await request.json();
    
    if (!item || typeof item !== 'string') {
      return NextResponse.json(
        { error: 'Item is required and must be a string' },
        { status: 400 }
      );
    }

    const prompt = `Нормализуй название продукта питания к каноничной форме на русском языке.

Правила нормализации:
- Приведи к единственному числу (помидоры → помидор)
- Убери уменьшительно-ласкательные суффиксы (яблочки → яблоко)
- Приведи к стандартному названию (сёмга → лосось, картошка → картофель)
- Группируй похожие продукты (все виды капусты → капуста)
- Сохрани основное значение продукта

Примеры:
- "помидоры" → "помидор"
- "яблочки" → "яблоко"
- "сёмга" → "лосось"
- "овсяные хлопья" → "овсяная крупа"
- "белокочанная капуста" → "капуста"

Продукт: "${item}"
Каноничная форма:`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 50,
      temperature: 0.1, // Низкая температура для консистентности
    });

    const canonical = response.choices[0]?.message?.content?.trim() || item;
    
    return NextResponse.json({ 
      original: item,
      canonical: canonical.toLowerCase()
    });

  } catch (error) {
    console.error('Canonicalization error:', error);
    return NextResponse.json(
      { error: 'Failed to canonicalize item' },
      { status: 500 }
    );
  }
}