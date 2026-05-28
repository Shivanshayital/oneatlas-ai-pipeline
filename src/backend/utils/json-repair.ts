import { logger } from "../logging/logger";

type JsonParseResult<T> = {
  success: boolean;
  data: T | null;
  repaired: boolean;
  error?: string;
  source?: string;
};

/**
 * Extracts the largest balanced-looking JSON object or array from arbitrary LLM text.
 */
export function extractLargestJsonBlock(input: string): string {
  const text = stripMarkdownFences(input).trim();
  let best = "";

  for (let index = 0; index < text.length; index += 1) {
    const opener = text[index];
    if (opener !== "{" && opener !== "[") continue;

    const closer = opener === "{" ? "}" : "]";
    const stack: string[] = [closer];
    let inString = false;
    let escaped = false;

    for (let cursor = index + 1; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (char === '"' && !escaped) {
        inString = !inString;
      }

      if (!inString) {
        if (char === "{") stack.push("}");
        if (char === "[") stack.push("]");
        if ((char === "}" || char === "]") && stack.at(-1) === char) {
          stack.pop();
          if (stack.length === 0) {
            const candidate = text.slice(index, cursor + 1);
            if (candidate.length > best.length) best = candidate;
            break;
          }
        }
      }

      escaped = char === "\\" && !escaped;
      if (char !== "\\") escaped = false;
    }
  }

  if (best) return best;

  const firstObject = text.indexOf("{");
  const firstArray = text.indexOf("[");
  const start =
    firstObject === -1 ? firstArray :
    firstArray === -1 ? firstObject :
    Math.min(firstObject, firstArray);

  return start >= 0 ? text.slice(start) : text;
}

/**
 * Attempts to fix common JSON syntax errors produced by LLMs.
 * Handles truncated JSON, markdown fences, missing commas, invalid quotes, and surrounding text.
 */
export function repairMalformedJson(input: string): string {
  if (!input) return "";

  let repaired = extractLargestJsonBlock(input);

  repaired = repaired
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\bundefined\b/g, "null")
    .replace(/\bNaN\b/g, "null");

  repaired = repaired
    .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/g, '$1"$2"$3')
    .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, value: string) => `:"${value.replace(/"/g, '\\"')}"`)
    .replace(/"\s*"/g, '", "')
    .replace(/}\s*{/g, "}, {")
    .replace(/]\s*\[/g, "], [")
    .replace(/}\s*"/g, '}, "')
    .replace(/]\s*"/g, '], "')
    .replace(/"\s*{/g, '", {');

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

  if (isInsideString) {
    repaired += '"';
  }

  while (stack.length > 0) {
    repaired += stack.pop();
  }

  repaired = repaired.replace(/,\s*([\]}])/g, "$1");

  return repaired;
}

export function repairJson(input: string): string {
  return repairMalformedJson(input);
}

export function safeJsonParse<T = unknown>(input: string): JsonParseResult<T> {
  try {
    return {
      success: true,
      data: JSON.parse(input) as T,
      repaired: false,
      source: input,
    };
  } catch (directError) {
    const repaired = repairMalformedJson(input);
    try {
      const data = JSON.parse(repaired) as T;
      logger.info("JSON repair succeeded", {
        originalLength: input.length,
        repairedLength: repaired.length,
      });
      return {
        success: true,
        data,
        repaired: true,
        source: repaired,
      };
    } catch (repairError) {
      return {
        success: false,
        data: null,
        repaired: true,
        source: repaired,
        error: repairError instanceof Error ? repairError.message : String(directError),
      };
    }
  }
}

/**
 * Robustly extracts and parses JSON from a string, applying repairs if standard parsing fails.
 */
export function extractJSON<T>(input: string): { success: boolean; data: T | null; error?: string } {
  const result = safeJsonParse<T>(input);
  return { success: result.success, data: result.data, error: result.error };
}

function stripMarkdownFences(input: string): string {
  return input.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, "$1");
}
