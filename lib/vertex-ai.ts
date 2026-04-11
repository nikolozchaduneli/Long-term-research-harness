import { GoogleAuth } from "google-auth-library";

// --- Configuration ---

export type EffortLevel = "low" | "medium" | "high" | "max";

type VertexConfig = {
  projectId: string;
  region: string;
  model: string;
  effort: EffortLevel;
};

export function getVertexConfig(): VertexConfig | null {
  const projectId = process.env.VERTEX_PROJECT_ID;
  if (!projectId) return null;
  const rawEffort = (process.env.VERTEX_EFFORT || "high").toLowerCase();
  const effort: EffortLevel = (["low", "medium", "high", "max"] as const).includes(rawEffort as EffortLevel)
    ? (rawEffort as EffortLevel)
    : "high";
  return {
    projectId,
    region: process.env.VERTEX_REGION || "us-east5",
    model: process.env.VERTEX_MODEL || "claude-opus-4-6@20250514",
    effort,
  };
}

// --- OAuth token management ---

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAt) {
    return cachedToken.token;
  }
  const client = await auth.getClient();
  const res = await client.getAccessToken();
  const token = typeof res === "string" ? res : res?.token;
  if (!token) throw new Error("Failed to obtain access token from ADC");
  // Cache with 55-minute expiry (tokens last ~60 min)
  cachedToken = { token, expiresAt: now + 55 * 60 * 1000 };
  return token;
}

// --- Types ---

export type VertexCallOptions = {
  system: string;
  userContent: string;
  effort?: EffortLevel;        // defaults to env VERTEX_EFFORT or "high"
  temperature?: number;        // only used when thinking is disabled
  disableThinking?: boolean;   // if true, uses thinking: disabled + temperature
  maxTokens?: number;
};

export type VertexResponse = {
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
  response: VertexResponse;
  modeUsed: "adaptive" | "no-thinking";
  attemptErrors: AttemptError[];
};

// --- Core API call ---

export async function callVertex(options: VertexCallOptions): Promise<VertexResponse> {
  const config = getVertexConfig();
  if (!config) throw new Error("Vertex AI not configured");

  const token = await getAccessToken();
  // "global" uses aiplatform.googleapis.com (no region prefix), regional uses {region}-aiplatform.googleapis.com
  const host = config.region === "global"
    ? "aiplatform.googleapis.com"
    : `${config.region}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${config.projectId}/locations/${config.region}/publishers/anthropic/models/${config.model}:rawPredict`;

  const effort = options.effort ?? config.effort;
  const useThinking = !options.disableThinking;
  const maxTokens = options.maxTokens ?? (useThinking ? 16384 : 4096);

  const body: Record<string, unknown> = {
    anthropic_version: "vertex-2023-10-16",
    max_tokens: maxTokens,
    system: options.system,
    messages: [{ role: "user", content: options.userContent }],
    output_config: { effort },
  };

  if (useThinking) {
    body.thinking = { type: "adaptive" };
    // temperature must NOT be set when thinking is active
  } else {
    body.thinking = { type: "disabled" };
    body.temperature = options.temperature ?? 0.2;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    const err = new Error(`Vertex AI call failed: ${response.status}`);
    (err as unknown as Record<string, unknown>).status = response.status;
    (err as unknown as Record<string, unknown>).body = errorBody;
    throw err;
  }

  const data = await response.json();
  return parseVertexResponse(data);
}

function parseVertexResponse(data: unknown): VertexResponse {
  const result: VertexResponse = { text: "" };

  if (!data || typeof data !== "object") return result;

  const content = (data as { content?: unknown[] }).content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const blockType = (block as { type?: string }).type;
      if (blockType === "thinking") {
        result.thinkingText = (block as { thinking?: string }).thinking ?? "";
      } else if (blockType === "text") {
        result.text = (block as { text?: string }).text ?? "";
      }
    }
  }

  const usage = (data as { usage?: Record<string, number> }).usage;
  if (usage && typeof usage === "object") {
    result.inputTokens = usage.input_tokens;
    result.outputTokens = usage.output_tokens;
  }

  return result;
}

// --- Two-variant caller (adaptive thinking first, no-thinking fallback) ---

export type CallWithFallbackOptions = {
  system: string;
  userContent: string;
  effort?: EffortLevel;
  fallbackTemperature?: number;
  maxTokensThinking?: number;
  maxTokensFallback?: number;
};

export async function callWithFallback(
  options: CallWithFallbackOptions,
): Promise<CallWithFallbackResult> {
  const attemptErrors: AttemptError[] = [];

  // Attempt 1: adaptive thinking with configured effort
  try {
    const response = await callVertex({
      system: options.system,
      userContent: options.userContent,
      effort: options.effort,
      maxTokens: options.maxTokensThinking ?? 16384,
    });
    return { response, modeUsed: "adaptive", attemptErrors };
  } catch (err: unknown) {
    const errObj = err as Record<string, unknown>;
    attemptErrors.push({
      mode: "adaptive",
      status: (typeof errObj.status === "number" ? errObj.status : 0),
      errorSnippet: String(errObj.body ?? errObj.message ?? "unknown").slice(0, 260),
    });
  }

  // Attempt 2: no thinking, temperature fallback
  try {
    const response = await callVertex({
      system: options.system,
      userContent: options.userContent,
      disableThinking: true,
      temperature: options.fallbackTemperature ?? 0.2,
      maxTokens: options.maxTokensFallback ?? 4096,
    });
    return { response, modeUsed: "no-thinking", attemptErrors };
  } catch (err: unknown) {
    const errObj = err as Record<string, unknown>;
    attemptErrors.push({
      mode: "no-thinking",
      status: (typeof errObj.status === "number" ? errObj.status : 0),
      errorSnippet: String(errObj.body ?? errObj.message ?? "unknown").slice(0, 260),
    });
  }

  throw Object.assign(new Error("All Vertex AI request variants failed"), { attemptErrors });
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
