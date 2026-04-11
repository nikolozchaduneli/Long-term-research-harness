/**
 * AI Provider dispatcher.
 *
 * Set AI_PROVIDER=azure or AI_PROVIDER=vertex in .env.local.
 * Defaults to "vertex" if not set.
 *
 * Both providers expose the same interface so routes don't care which is active.
 */

import * as vertex from "./vertex-ai";
import * as azure from "./azure-openai";

export type { EffortLevel } from "./vertex-ai";

export type AiResponse = {
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

export type CallResult = {
  response: AiResponse;
  modeUsed: "adaptive" | "no-thinking";
  attemptErrors: AttemptError[];
};

export type CallOptions = {
  system: string;
  userContent: string;
  effort?: vertex.EffortLevel;
  temperature?: number;
  disableThinking?: boolean;
  maxTokens?: number;
};

export type CallWithFallbackOptions = {
  system: string;
  userContent: string;
  effort?: vertex.EffortLevel;
  fallbackTemperature?: number;
  maxTokensThinking?: number;
  maxTokensFallback?: number;
};

function getProvider(): "azure" | "vertex" {
  const raw = (process.env.AI_PROVIDER || "vertex").toLowerCase();
  if (raw === "azure") return "azure";
  return "vertex";
}

/** Returns true if any AI provider is configured. */
export function isConfigured(): boolean {
  const provider = getProvider();
  if (provider === "azure") return azure.getAzureConfig() !== null;
  return vertex.getVertexConfig() !== null;
}

/** Single call to the configured AI provider. */
export async function callAi(options: CallOptions): Promise<AiResponse> {
  const provider = getProvider();
  if (provider === "azure") {
    return azure.callAzure(options);
  }
  return vertex.callVertex(options);
}

/** Two-variant call (thinking first, then fallback). */
export async function callWithFallback(options: CallWithFallbackOptions): Promise<CallResult> {
  const provider = getProvider();
  if (provider === "azure") {
    return azure.callWithFallback(options);
  }
  return vertex.callWithFallback(options);
}

/** Extract JSON from model response text. */
export function extractJson(content: string): unknown {
  return vertex.extractJson(content);
}
