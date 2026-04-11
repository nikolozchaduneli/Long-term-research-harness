// --- Azure OpenAI provider (same interface as vertex-ai.ts) ---

import type { EffortLevel } from "./vertex-ai";

export type { EffortLevel };

type AzureConfig = {
  endpoint: string;
  responsesUrl: string | null;
  apiKey: string;
  deployment: string;
  apiVersion: string;
};

export function getAzureConfig(): AzureConfig | null {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const responsesUrl = process.env.AZURE_OPENAI_RESPONSES_URL || null;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  if ((!endpoint && !responsesUrl) || !apiKey || !deployment) return null;
  return {
    endpoint: endpoint || "",
    responsesUrl,
    apiKey,
    deployment,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-10-21",
  };
}

// --- Types (re-exported to match vertex-ai interface) ---

export type AzureCallOptions = {
  system: string;
  userContent: string;
  effort?: EffortLevel;
  temperature?: number;
  disableThinking?: boolean;
  maxTokens?: number;
  jsonSchema?: { name: string; strict: boolean; schema: Record<string, unknown> };
};

export type AzureResponse = {
  text: string;
  thinkingText?: string;
  inputTokens?: number;
  outputTokens?: number;
};

export type AttemptError = {
  mode: string;
  status: number;
  errorSnippet: string;
};

export type CallWithFallbackResult = {
  response: AzureResponse;
  modeUsed: "adaptive" | "no-thinking";
  attemptErrors: AttemptError[];
};

// --- URL construction ---

function buildRequestUrl(config: AzureConfig): string {
  const normalize = (value: string) =>
    value.trim().replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");

  if (config.responsesUrl) {
    const normalized = normalize(config.responsesUrl).replace(/\/+$/, "");
    return normalized.includes("api-version=")
      ? normalized
      : `${normalized}?api-version=${config.apiVersion}`;
  }

  const normalizedEndpoint = normalize(config.endpoint)
    .replace(/\/+$/, "")
    .replace(/\/openai\/.*$/, "");
  return `${normalizedEndpoint}/openai/deployments/${config.deployment}/responses?api-version=${config.apiVersion}`;
}

// --- Response parsing (Azure OpenAI Responses API format) ---

function getOutputText(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const outputText = (data as { output_text?: unknown }).output_text;
  if (typeof outputText === "string") return outputText;
  const output = (data as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    const textParts = content
      .map((part) => {
        if (!part || typeof part !== "object") return null;
        const textValue = (part as { text?: unknown }).text;
        if (typeof textValue === "string") return textValue;
        const outputTextValue = (part as { output_text?: unknown }).output_text;
        if (typeof outputTextValue === "string") return outputTextValue;
        return null;
      })
      .filter(Boolean);
    if (textParts.length > 0) return textParts.join("");
  }
  return null;
}

function getReasoningTokens(data: unknown): number | undefined {
  if (!data || typeof data !== "object") return undefined;
  const usage = (data as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const outputDetails = (usage as { output_tokens_details?: unknown }).output_tokens_details;
  if (!outputDetails || typeof outputDetails !== "object") return undefined;
  const reasoningTokens = (outputDetails as { reasoning_tokens?: unknown }).reasoning_tokens;
  return typeof reasoningTokens === "number" ? reasoningTokens : undefined;
}

// --- Core API call ---

export async function callAzure(options: AzureCallOptions): Promise<AzureResponse> {
  const config = getAzureConfig();
  if (!config) throw new Error("Azure OpenAI not configured");

  const requestUrl = buildRequestUrl(config);

  const requestBody: Record<string, unknown> = {
    instructions: options.system,
    input: options.userContent,
    model: config.deployment,
  };

  if (options.jsonSchema) {
    requestBody.text = {
      format: {
        type: "json_schema" as const,
        name: options.jsonSchema.name,
        strict: options.jsonSchema.strict,
        schema: options.jsonSchema.schema,
      },
    };
  }

  if (!options.disableThinking) {
    requestBody.reasoning = { effort: "high" };
  } else {
    requestBody.temperature = options.temperature ?? 0.2;
  }

  const response = await fetch(requestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": config.apiKey,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    const err = new Error(`Azure OpenAI call failed: ${response.status}`);
    (err as unknown as Record<string, unknown>).status = response.status;
    (err as unknown as Record<string, unknown>).body = errorBody;
    throw err;
  }

  const data = await response.json();
  const text = getOutputText(data);
  const reasoningTokens = getReasoningTokens(data);

  return {
    text: text ?? "",
    thinkingText: reasoningTokens ? `(${reasoningTokens} reasoning tokens used)` : undefined,
    inputTokens: undefined,
    outputTokens: reasoningTokens,
  };
}

// --- Two-variant caller (reasoning first, temperature fallback) ---

export type CallWithFallbackOptions = {
  system: string;
  userContent: string;
  effort?: EffortLevel;
  fallbackTemperature?: number;
  maxTokensThinking?: number;
  maxTokensFallback?: number;
  jsonSchema?: { name: string; strict: boolean; schema: Record<string, unknown> };
};

export async function callWithFallback(
  options: CallWithFallbackOptions,
): Promise<CallWithFallbackResult> {
  const attemptErrors: AttemptError[] = [];

  // Attempt 1: with reasoning
  try {
    const response = await callAzure({
      system: options.system,
      userContent: options.userContent,
      jsonSchema: options.jsonSchema,
    });
    return { response, modeUsed: "adaptive", attemptErrors };
  } catch (err: unknown) {
    const errObj = err as Record<string, unknown>;
    attemptErrors.push({
      mode: "reasoning",
      status: typeof errObj.status === "number" ? errObj.status : 0,
      errorSnippet: String(errObj.body ?? errObj.message ?? "unknown").slice(0, 260),
    });
  }

  // Attempt 2: temperature fallback (no reasoning)
  try {
    const response = await callAzure({
      system: options.system,
      userContent: options.userContent,
      disableThinking: true,
      temperature: options.fallbackTemperature ?? 0.2,
      jsonSchema: options.jsonSchema,
    });
    return { response, modeUsed: "no-thinking", attemptErrors };
  } catch (err: unknown) {
    const errObj = err as Record<string, unknown>;
    attemptErrors.push({
      mode: "temperature",
      status: typeof errObj.status === "number" ? errObj.status : 0,
      errorSnippet: String(errObj.body ?? errObj.message ?? "unknown").slice(0, 260),
    });
  }

  throw Object.assign(new Error("All Azure OpenAI request variants failed"), { attemptErrors });
}

// --- Shared JSON extractor ---

export function extractJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(content.slice(start, end + 1));
    }
    throw new Error("No parseable JSON found in response");
  }
}
