export interface TaskRequirements { change: boolean; tests: boolean }

export function taskRequirements(text: string): TaskRequirements {
  const explicitReadOnly = /(?:read[- ]only|do not (?:change|modify|edit) (?:files|code)|только (?:чтени|анализ)|не (?:изменяй|меняй|редактируй) (?:файлы|код))/i.test(text);
  const question = /^(?:how\b|why\b|what\b|как\s|почему\s|что\s)/i.test(text.trim());
  const advice = /(?:предложи|объясни|explain|suggest)/i.test(text);
  const imperative = /(?:^(?:fix|implement|create|add|edit|replace|delete)\b|\b(?:and|then|also)\s+(?:fix|implement|create|add|edit)\b|исправь|реализуй|создай|добавь|измени|удали)/i.test(text);
  const readOnly = explicitReadOnly || ((question || advice) && !imperative);
  return {
    change: !readOnly && /(?:\b(?:fix|implement|create|add|edit|replace|delete|build)\b|исправ|реализ|созда|добав|замен|удал|измен)/i.test(text),
    tests: !readOnly && !/(?:не запускай|do not run|don't run)/i.test(text) && /(?:\b(?:tests?|build|typecheck|verify)\b|тест|провер)/i.test(text),
  };
}

export function looksLikePlan(text: string): boolean {
  return /(?:\bI (?:will|need to|am going to) (?:fix|edit|create|run|read|check)|\bLet me (?:fix|edit|run|read|check)|(?:сейчас|далее|теперь) (?:я )?(?:исправлю|изменю|создам|запущу|прочитаю|проверю))/i.test(text);
}

export function reportsBlocked(text: string): boolean {
  return /(?:\b(?:blocked|unable to|cannot|can't)\b|заблокир|не могу|недостаточно прав|нужно разрешение)/i.test(text);
}
