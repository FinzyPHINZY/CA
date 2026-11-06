/**
 * Best-effort extraction of total LLM tokens from LangChain / Google GenAI
 * invoke results (including structured-output wrappers that expose `.raw`).
 * Never throws: malformed or hostile objects must not break callers.
 */
const MAX_NEST_DEPTH = 8;

function readNumber(
  obj: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && !Number.isNaN(v)) {
      return v;
    }
    if (typeof v === 'bigint') {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

function extractFromMessageLikeObject(obj: unknown, depth = 0): number | null {
  if (depth > MAX_NEST_DEPTH) {
    return null;
  }
  if (!obj || typeof obj !== 'object') {
    return null;
  }
  const m = obj as Record<string, unknown>;

  const um = m.usage_metadata as Record<string, unknown> | undefined;
  if (um) {
    const total = readNumber(um, ['total_tokens', 'totalTokens']);
    if (total != null && total > 0) {
      return Math.round(total);
    }
    const input =
      readNumber(um, ['input_tokens', 'inputTokens', 'prompt_tokens']) ?? 0;
    const output =
      readNumber(um, ['output_tokens', 'outputTokens', 'completion_tokens']) ??
      0;
    const sum = input + output;
    if (sum > 0) {
      return Math.round(sum);
    }
  }

  const lc = m.lc_kwargs as Record<string, unknown> | undefined;
  if (lc) {
    const nested = extractFromMessageLikeObject(lc, depth + 1);
    if (nested != null) {
      return nested;
    }
  }

  const rm = m.response_metadata as Record<string, unknown> | undefined;
  if (rm) {
    const usage = rm.usage as Record<string, unknown> | undefined;
    if (usage) {
      const total = readNumber(usage, [
        'totalTokenCount',
        'total_tokens',
        'totalTokens',
      ]);
      if (total != null && total > 0) {
        return Math.round(total);
      }
      const prompt =
        readNumber(usage, ['promptTokenCount', 'input_tokens']) ?? 0;
      const candidates =
        readNumber(usage, ['candidatesTokenCount', 'output_tokens']) ?? 0;
      const sum = prompt + candidates;
      if (sum > 0) {
        return Math.round(sum);
      }
    }
  }

  const usageMeta = m.usageMetadata as Record<string, unknown> | undefined;
  if (usageMeta) {
    return extractFromMessageLikeObject(
      { usage_metadata: usageMeta },
      depth + 1,
    );
  }

  return null;
}

function collectCandidateObjects(invokeResult: unknown): unknown[] {
  try {
    if (!invokeResult || typeof invokeResult !== 'object') {
      return [];
    }
    const r = invokeResult as Record<string, unknown>;
    const out: unknown[] = [invokeResult];
    if (r.raw) {
      out.push(r.raw);
    }
    if (r.message) {
      out.push(r.message);
    }
    return out;
  } catch {
    return [];
  }
}

/** Returns total tokens for one successful model call, or null if unknown. */
export function extractTotalTokensFromLangChainInvokeResult(
  invokeResult: unknown,
): number | null {
  try {
    for (const candidate of collectCandidateObjects(invokeResult)) {
      try {
        const n = extractFromMessageLikeObject(candidate);
        if (n != null && n > 0) {
          return n;
        }
      } catch {
        continue;
      }
    }
    return null;
  } catch (err: unknown) {
    console.warn(
      '[GeminiTokenUsage] token_extraction_failed',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
