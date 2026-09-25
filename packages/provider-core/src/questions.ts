import type { AsyncQuestion } from './index.ts';

/** Compare only visible content; native history may regenerate item IDs on every read. */
export function questionSignature(text: string, questions: unknown): string | undefined {
  if (!Array.isArray(questions) || !questions.length || questions.some((q) => typeof q?.title !== 'string'))
    return;
  return JSON.stringify([text.trim(), questions.map((q) => [q.title, q.options ?? null])]);
}

/** Hide only a verbatim question body, never surrounding explanations or instructions. */
export function questionBody(text: string, questions?: AsyncQuestion[]): string {
  if (!questions?.length) return text;
  const titles = questions.map((q) => q.title.trim());
  return [titles.join('\n'), titles.join('\n\n')].includes(text.trim()) ? '' : text;
}
