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

  private normalizeBasic(item: string): string {
    let key = (item || "").trim().toLowerCase();
    key = key.replace(/[.!?;:,()\[\]{}"'`]+/g, "");
    key = key.replace(/\s{2,}/g, " ");
    return key;
  }

  canonicalize(item: string): string {
    const key = this.normalizeBasic(item);
    return this.map[key] || key;
  }

  canonicalizeList(items: string[] = []): string[] {
    return Array.from(new Set(items.map((i) => this.canonicalize(i)).filter(Boolean)));
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
}