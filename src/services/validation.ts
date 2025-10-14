export class ValidationService {
  isComplete(data: any): boolean {
    // Каркас валидации полноты данных
    if (!data) return false;
    return true;
  }
}