// ============================================================================
// Safe JSON Extraction and Parsing
// ============================================================================

export interface ParseResult {
  success: boolean;
  data: Record<string, unknown> | null;
  error?: string;
  rawText: string;
}

const KEY_QUOTE_PATTERN = /([,{]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g;
const TRAILING_COMMA_PATTERN = /,(\s*[}\]])/g;
const SINGLE_QUOTE_STRING_PATTERN = /'([^']*)'/g;

export function sanitizeJsonString(text: string): string {
  let sanitized = text.replace(/\uFEFF/g, "").replace(/\r\n/g, "\n").trim();
  sanitized = sanitized.replace(/```(?:json)?\n?/gi, "").replace(/```\n?/g, "");
  sanitized = sanitized.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  sanitized = sanitized.replace(/\t/g, " ");

  const firstJson = sanitized.search(/[\{\[]/);
  if (firstJson > 0) {
    sanitized = sanitized.substring(firstJson);
  }

  return sanitized;
}

export function extractJsonBlock(text: string): string | null {
  const cleaned = sanitizeJsonString(text);
  const startIndex = cleaned.search(/[\{\[]/);
  if (startIndex === -1) {
    return null;
  }

  const opening = cleaned[startIndex];
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < cleaned.length; index += 1) {
    const char = cleaned[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === opening) {
      depth += 1;
    }

    if (char === closing) {
      depth -= 1;
      if (depth === 0) {
        return cleaned.slice(startIndex, index + 1);
      }
    }
  }

  return cleaned.slice(startIndex);
}

export function autoCloseJsonStructures(text: string): string {
  let candidate = text.trim();
  candidate = candidate.replace(TRAILING_COMMA_PATTERN, "$1");
  candidate = candidate.replace(KEY_QUOTE_PATTERN, "$1\"$2\"$3");
  candidate = candidate.replace(SINGLE_QUOTE_STRING_PATTERN, '"$1"');

  const openBraces = (candidate.match(/\{/g) || []).length;
  const closeBraces = (candidate.match(/\}/g) || []).length;
  if (openBraces > closeBraces) {
    candidate += "}".repeat(openBraces - closeBraces);
  }

  const openBrackets = (candidate.match(/\[/g) || []).length;
  const closeBrackets = (candidate.match(/\]/g) || []).length;
  if (openBrackets > closeBrackets) {
    candidate += "]".repeat(openBrackets - closeBrackets);
  }

  return candidate;
}

export function safeParseJson(
  jsonStr: string
): { success: boolean; data: Record<string, unknown> | null; error?: string } {
  const cleaned = sanitizeJsonString(jsonStr);
  const extracted = extractJsonBlock(cleaned) ?? cleaned;
  const repaired = autoCloseJsonStructures(extracted);

  try {
    const parsed = JSON.parse(repaired);
    if (typeof parsed === "object" && parsed !== null) {
      return { success: true, data: parsed as Record<string, unknown> };
    }
    return {
      success: false,
      data: null,
      error: "Parsed value is not an object",
    };
  } catch (error) {
    return {
      success: false,
      data: null,
      error: `JSON parse error: ${String(error)}`,
    };
  }
}

export function extractJSON(text: string): ParseResult {
  const rawText = text.trim();
  const sanitized = sanitizeJsonString(rawText);

  const directResult = safeParseJson(sanitized);
  if (directResult.success && directResult.data) {
    return { success: true, data: directResult.data, rawText };
  }

  const block = extractJsonBlock(rawText);
  if (block) {
    const blockResult = safeParseJson(block);
    if (blockResult.success && blockResult.data) {
      return { success: true, data: blockResult.data, rawText };
    }
  }

  const repaired = autoCloseJsonStructures(sanitized);
  const repairedResult = safeParseJson(repaired);
  if (repairedResult.success && repairedResult.data) {
    return { success: true, data: repairedResult.data, rawText };
  }

  return {
    success: false,
    data: null,
    error: directResult.error ?? "Failed to extract valid JSON from response",
    rawText,
  };
}

export function parseJSON(
  jsonStr: string
): { success: boolean; data: Record<string, unknown> | null; error?: string } {
  return safeParseJson(jsonStr);
}

export function extractAndRepairJSON(text: string): {
  json: Record<string, unknown> | null;
  repairs: string[];
} {
  const repairs: string[] = [];
  let working = text.trim();

  const sanitized = sanitizeJsonString(working);
  if (sanitized !== working) {
    repairs.push("Sanitized markdown and invalid characters");
    working = sanitized;
  }

  const block = extractJsonBlock(working);
  if (block && block !== working) {
    repairs.push("Extracted JSON block from surrounding text");
    working = block;
  }

  const closed = autoCloseJsonStructures(working);
  if (closed !== working) {
    repairs.push("Auto-closed JSON structures and fixed common syntax issues");
    working = closed;
  }

  const parsed = safeParseJson(working);
  if (parsed.success && parsed.data) {
    return { json: parsed.data, repairs };
  }

  if (parsed.error) {
    repairs.push(`Final parse error: ${parsed.error}`);
  }

  return { json: null, repairs };
}
