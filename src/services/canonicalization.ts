// src\services\canonicalization.ts
// Нормализация названий продуктов питания к единому каноническому виду

export class CanonicalizationService {
  private map: Record<string, string> = {
    // овощи/фрукты
    "помидоры": "помидор",
    "томаты": "помидор",
    "огурцы": "огурец",
    "картошка": "картофель",
    "яблочки": "яблоко",
    "яблоки": "яблоко",
    "апельсины": "апельсин",
    "бананы": "банан",
    // мясо/рыба/молочка
    "курицу": "курица",
    "курица": "курица",
    "говядина": "говядина",
    "свинина": "свинина",
    "рыба": "рыба",
    "лосось": "лосось",
    "сёмга": "лосось",
    "сливочное масло": "масло сливочное",
    "масло сливочное": "масло сливочное",
    "йогурты": "йогурт",
    "йогурт": "йогурт",
    // крупы/хлеб
    "гречка": "гречка",
    "рис": "рис",
    "овсянка": "овсяная крупа",
    "овсяные хлопья": "овсяная крупа",
    // прочее
    "сахар": "сахар",
    "сладкое": "сладости",
    "сладости": "сладости",
    "газировка": "газированные напитки",
    // капуста — приводим варианты к общему термину
    "капуста": "капуста",
    "капуста белокочанная": "капуста",
    "белокочанная капуста": "капуста",
    "капуста пекинская": "капуста",
    "пекинская капуста": "капуста",
    "капуста савойская": "капуста",
    "савойская капуста": "капуста",
    "цветная капуста": "капуста",
    "капуста цветная": "капуста",
    "брокколи": "капуста",
    "капуста брокколи": "капуста",
  };

  // Кэш для AI-нормализованных продуктов
  private aiCache: Record<string, string> = {};
  
  // Флаг для включения/выключения AI нормализации
  private useAI: boolean = true;

  private normalizeBasic(item: string): string {
    let key = (item || "").trim().toLowerCase();
    key = key.replace(/[.!?;:,()\[\]{}"'`]+/g, "");
    key = key.replace(/\s{2,}/g, " ");
    return key;
  }

  // AI-powered нормализация продукта
  private async canonicalizeWithAI(item: string): Promise<string> {
    try {
      const response = await fetch('/api/canonicalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item })
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      return data.canonical || item;
    } catch (error) {
      console.warn('AI canonicalization failed:', error);
      return item; // Fallback к оригинальному названию
    }
  }

  // Синхронная версия (использует кэш)
  canonicalize(item: string): string {
    const key = this.normalizeBasic(item);
    return this.map[key] || key;
  }

  // Асинхронная версия с AI
  async canonicalizeAsync(item: string): Promise<string> {
    const key = this.normalizeBasic(item);
    
    // 1. Проверяем статический словарь
    if (this.map[key]) {
      return this.map[key];
    }
    
    // 2. Проверяем AI кэш
    if (this.aiCache[key]) {
      return this.aiCache[key];
    }
    
    // 3. Если AI отключен, возвращаем как есть
    if (!this.useAI) {
      return key;
    }
    
    // 4. Используем AI для нормализации
    const canonical = await this.canonicalizeWithAI(item);
    
    // 5. Кэшируем результат
    this.aiCache[key] = canonical;
    
    return canonical;
  }

  canonicalizeList(items: string[] = []): string[] {
    return Array.from(new Set(items.map((i) => this.canonicalize(i)).filter(Boolean)));
  }

  // Асинхронная версия для списков
  async canonicalizeListAsync(items: string[] = []): Promise<string[]> {
    const canonicalized = await Promise.all(
      items.map(item => this.canonicalizeAsync(item))
    );
    return Array.from(new Set(canonicalized.filter(Boolean)));
  }

  canonicalizeFacts(facts: any): any {
    const out = { ...facts };
    if (Array.isArray(out.householdLikes)) out.householdLikes = this.canonicalizeList(out.householdLikes);
    if (Array.isArray(out.householdDislikes)) out.householdDislikes = this.canonicalizeList(out.householdDislikes);
    if (Array.isArray(out.householdAllergies)) out.householdAllergies = this.canonicalizeList(out.householdAllergies);
    if (Array.isArray(out.members)) {
      out.members = out.members.map((m: any) => ({
        ...m,
        name: typeof m?.name === "string" ? this.normalizeBasic(m.name) : m?.name,
        likes: this.canonicalizeList(m.likes || []),
        dislikes: this.canonicalizeList(m.dislikes || []),
        allergies: this.canonicalizeList(m.allergies || []),
      }));
    }
    return out;
  }

  // Асинхронная версия для фактов
  async canonicalizeFactsAsync(facts: any): Promise<any> {
    const out = { ...facts };
    
    if (Array.isArray(out.householdLikes)) {
      out.householdLikes = await this.canonicalizeListAsync(out.householdLikes);
    }
    if (Array.isArray(out.householdDislikes)) {
      out.householdDislikes = await this.canonicalizeListAsync(out.householdDislikes);
    }
    if (Array.isArray(out.householdAllergies)) {
      out.householdAllergies = await this.canonicalizeListAsync(out.householdAllergies);
    }
    
    if (Array.isArray(out.members)) {
      out.members = await Promise.all(
        out.members.map(async (m: any) => ({
          ...m,
          name: typeof m?.name === "string" ? this.normalizeBasic(m.name) : m?.name,
          likes: await this.canonicalizeListAsync(m.likes || []),
          dislikes: await this.canonicalizeListAsync(m.dislikes || []),
          allergies: await this.canonicalizeListAsync(m.allergies || []),
        }))
      );
    }
    
    return out;
  }

  // Утилиты для управления AI
  enableAI(): void {
    this.useAI = true;
  }

  disableAI(): void {
    this.useAI = false;
  }

  clearAICache(): void {
    this.aiCache = {};
  }

  getAICacheSize(): number {
    return Object.keys(this.aiCache).length;
  }
}