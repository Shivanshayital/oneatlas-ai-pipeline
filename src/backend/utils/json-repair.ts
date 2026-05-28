/**
 * Attempts to fix common JSON syntax errors produced by LLMs.
 * Handles truncated JSON, markdown fences, missing commas, and surrounding text.
 */
export function repairJson(input: string): string {
  if (!input) return "";

  let repaired = input.trim();

  // 1. Remove Markdown code fences (e.g., ```json ... ```)
  repaired = repaired.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, "$1").trim();

  // 2. Locate the start of the JSON object or array
  // This strips any conversational text prefix provided by the model
  const firstBrace = repaired.indexOf("{");
  const firstBracket = repaired.indexOf("[");
  let startIndex = -1;

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIndex = firstBrace;
  } else if (firstBracket !== -1) {
    startIndex = firstBracket;
  }

  if (startIndex !== -1) {
    repaired = repaired.substring(startIndex);
  }

  // 3. Heuristic fixes for missing commas between elements/properties
  // LLMs often forget commas in large arrays or object definitions
  repaired = repaired
    .replace(/"\s*"/g, '", "')   // Missing comma between strings
    .replace(/}\s*{/g, "}, {")   // Missing comma between objects
    .replace(/]\s*\[/g, "], [")   // Missing comma between arrays
    .replace(/}\s*"/g, '}, "')   // Missing comma before next key
    .replace(/"\s*{/g, '", {');  // Missing comma before nested object

  // 4. Balance braces and brackets for truncated outputs
  const stack: string[] = [];
  let isInsideString = false;
  let escaped = false;

  for (let i = 0; i < repaired.length; i++) {
    const char = repaired[i];

    // Handle strings to avoid balancing brackets found inside quotes
    if (char === '"' && !escaped) {
      isInsideString = !isInsideString;
    }

    if (!isInsideString) {
      if (char === "{" || char === "[") {
        stack.push(char === "{" ? "}" : "]");
      } else if (char === "}" || char === "]") {
        if (stack.length > 0 && stack[stack.length - 1] === char) {
          stack.pop();
        }
      }
    }
    escaped = char === "\\" && !escaped;
  }

  // If the model cut off mid-string
  if (isInsideString) {
    repaired += '"';
  }

  // Close all remaining structures in correct order
  while (stack.length > 0) {
    repaired += stack.pop();
  }

  // 5. Remove illegal trailing commas (common LLM artifact)
  repaired = repaired.replace(/,\s*([\]}])/g, "$1");

  return repaired;
}

/**
 * Robustly extracts and parses JSON from a string, applying repairs if standard parsing fails.
 */
export function extractJSON<T>(input: string): { success: boolean; data: T | null; error?: string } {
  try {
    return { success: true, data: JSON.parse(input) };
  } catch {
    try {
      const repaired = repairJson(input);
      return { success: true, data: JSON.parse(repaired) };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  }
}