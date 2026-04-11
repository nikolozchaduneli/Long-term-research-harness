import { NextResponse } from "next/server";
import { z } from "zod";
import { isConfigured, callWithFallback, extractJson } from "@/lib/ai-provider";

const requestSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  goal: z.string().min(1),
  constraints: z
    .object({
      timeBudgetMinutes: z.number().int().positive().optional(),
      focusNotes: z.string().optional(),
      projectConstraints: z.string().optional(),
    })
    .optional(),
  task: z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    estimateMinutes: z.number().int().positive().max(480).optional(),
    status: z.enum(["todo", "doing", "done"]).optional(),
    milestoneTitle: z.string().optional(),
    milestoneDescription: z.string().optional(),
  }),
  relatedTasks: z
    .array(
      z.object({
        title: z.string().min(1),
        status: z.enum(["todo", "doing", "done"]).optional(),
        estimateMinutes: z.number().int().positive().max(480).optional(),
        milestoneTitle: z.string().optional(),
      }),
    )
    .max(8)
    .optional(),
  userIntent: z.string().max(400).optional(),
  sandboxNotes: z
    .object({
      definitionOfDone: z.string().max(1000).optional(),
      firstMove: z.string().max(1000).optional(),
      risks: z.string().max(1000).optional(),
    })
    .optional(),
});

const responseSchema = z.object({
  prompt: z.string().min(1),
  checklist: z.array(z.string().min(1)).min(3).max(8),
});

const buildContextSummary = (payload: z.infer<typeof requestSchema>) => {
  const milestoneTitle = payload.task.milestoneTitle?.trim() || "Whole Project";
  const milestoneDescription = payload.task.milestoneDescription?.trim() || "None";
  const taskDescription = payload.task.description?.trim() || "None";
  const focusNotes = payload.constraints?.focusNotes?.trim() || "None";
  const projectConstraints = payload.constraints?.projectConstraints?.trim() || "None";
  const userIntent = payload.userIntent?.trim() || "Solve this task end-to-end with high confidence.";
  const definitionOfDone = payload.sandboxNotes?.definitionOfDone?.trim() || "Not specified";
  const firstMove = payload.sandboxNotes?.firstMove?.trim() || "Not specified";
  const risks = payload.sandboxNotes?.risks?.trim() || "Not specified";

  const relatedTasks =
    payload.relatedTasks && payload.relatedTasks.length > 0
      ? payload.relatedTasks
        .map((task) => {
          const parts = [
            task.title.trim(),
            task.status ? `status: ${task.status}` : "",
            task.estimateMinutes ? `estimate: ${task.estimateMinutes}m` : "",
            task.milestoneTitle ? `milestone: ${task.milestoneTitle}` : "",
          ].filter(Boolean);
          return `- ${parts.join(" | ")}`;
        })
        .join("\n")
      : "- None";

  return {
    milestoneTitle,
    milestoneDescription,
    taskDescription,
    focusNotes,
    projectConstraints,
    userIntent,
    definitionOfDone,
    firstMove,
    risks,
    relatedTasks,
  };
};

const buildFallbackPrompt = (payload: z.infer<typeof requestSchema>) => {
  const summary = buildContextSummary(payload);
  const timeBudget = payload.constraints?.timeBudgetMinutes
    ? `${payload.constraints.timeBudgetMinutes} minutes/day`
    : "Not specified";
  const taskEstimate = payload.task.estimateMinutes
    ? `${payload.task.estimateMinutes} minutes`
    : "Not specified";

  return {
    prompt: `You are my senior execution copilot. Help me complete one focused task with concrete steps, quality checks, and minimal ambiguity.

PROJECT CONTEXT
- Project: ${payload.projectName}
- Project goal: ${payload.goal}
- Time budget: ${timeBudget}
- Focus notes: ${summary.focusNotes}
- Project constraints: ${summary.projectConstraints}

TASK CONTEXT
- Task title: ${payload.task.title}
- Task description: ${summary.taskDescription}
- Task estimate: ${taskEstimate}
- Task status: ${payload.task.status || "todo"}
- Milestone: ${summary.milestoneTitle}
- Milestone scope: ${summary.milestoneDescription}
- My specific objective: ${summary.userIntent}

SANDBOX NOTES
- Definition of done: ${summary.definitionOfDone}
- First 10-minute move idea: ${summary.firstMove}
- Risks/blockers: ${summary.risks}

RELATED TASKS
${summary.relatedTasks}

INSTRUCTIONS
1) If critical details are missing, ask up to 3 precise clarifying questions first.
2) Then produce:
   - A short execution plan (ordered steps, each with expected output).
   - The exact first action I should do right now.
   - Any code/commands/templates needed for the next step.
   - A verification checklist mapped to the definition of done.
   - A fallback path if assumptions fail.
3) Keep recommendations tightly scoped to this task and milestone.
4) Be explicit, concise, and implementation-ready.`,
    checklist: [
      "Confirm assumptions and request only essential clarifications.",
      "Create an ordered plan with clear outputs for each step.",
      "Start with the smallest high-leverage action immediately.",
      "Validate against definition of done and milestone scope.",
      "Call out risks early and provide fallback options.",
    ],
  };
};

const buildPrompt = (payload: z.infer<typeof requestSchema>) => {
  const summary = buildContextSummary(payload);
  const timeBudget = payload.constraints?.timeBudgetMinutes
    ? `${payload.constraints.timeBudgetMinutes} minutes/day`
    : "Not specified";
  const taskEstimate = payload.task.estimateMinutes
    ? `${payload.task.estimateMinutes} minutes`
    : "Not specified";

  return `
Create a single high-quality prompt that the user can paste into an advanced AI assistant to complete the task below.
The prompt must be practical, context-rich, and structured for reliable execution.

PROJECT
- Name: ${payload.projectName}
- Goal: ${payload.goal}
- Time budget: ${timeBudget}
- Focus notes: ${summary.focusNotes}
- Project constraints: ${summary.projectConstraints}

TASK
- Title: ${payload.task.title}
- Description: ${summary.taskDescription}
- Estimate: ${taskEstimate}
- Status: ${payload.task.status || "todo"}
- Milestone: ${summary.milestoneTitle}
- Milestone details: ${summary.milestoneDescription}
- User objective: ${summary.userIntent}

SANDBOX NOTES
- Definition of done: ${summary.definitionOfDone}
- First move candidate: ${summary.firstMove}
- Risks/blockers: ${summary.risks}

RELATED TASKS
${summary.relatedTasks}

RESPONSE REQUIREMENTS
- Return JSON with:
  - "prompt": the final prompt text.
  - "checklist": 4 to 6 short execution checks.
- The generated prompt must:
  1) Assign a clear expert role to the assistant.
  2) Include explicit task scope, constraints, and success criteria.
  3) Demand a step-by-step plan plus immediate next action.
  4) Require verification steps tied to definition of done.
  5) Include a missing-information policy (ask up to 3 clarifying questions).
  6) Keep output concise, actionable, and implementation-ready.
- Keep the final generated prompt under 450 words.
`;
};

export async function POST(request: Request) {
  const requestStartedAt = Date.now();
  const createDebugMeta = (
    overrides: Partial<{
      fallback: boolean;
      fallbackReason: string;
      modeUsed: "adaptive" | "no-thinking" | "none";
      attemptErrors: Array<{ mode: string; status: number; errorSnippet: string }>;
    }> = {},
  ) => ({
    latencyMs: Date.now() - requestStartedAt,
    modeRequested: "thinking",
    ...overrides,
  });

  const body = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const fallback = buildFallbackPrompt(parsed.data);

  if (!isConfigured()) {
    return NextResponse.json({
      ...fallback,
      meta: createDebugMeta({
        fallback: true,
        fallbackReason: "missing_ai_config",
        modeUsed: "none",
      }),
    });
  }

  try {
    const result = await callWithFallback({
      system: "You are an expert project execution coach and prompt engineer. Return only valid JSON matching this structure: { \"prompt\": string, \"checklist\": string[] }. The checklist should have 4 to 6 items. No other text.",
      userContent: buildPrompt(parsed.data),
      fallbackTemperature: 0.2,
    });

    const content = result.response.text;
    if (!content) {
      return NextResponse.json({
        ...fallback,
        meta: createDebugMeta({
          fallback: true,
          fallbackReason: "empty_response_text",
          modeUsed: result.modeUsed,
          attemptErrors: result.attemptErrors,
        }),
      });
    }

    let payload: unknown;
    try {
      payload = extractJson(content);
    } catch {
      return NextResponse.json({
        ...fallback,
        meta: createDebugMeta({
          fallback: true,
          fallbackReason: "unparseable_model_json",
          modeUsed: result.modeUsed,
          attemptErrors: result.attemptErrors,
        }),
      });
    }

    const validated = responseSchema.safeParse(payload);
    if (!validated.success) {
      return NextResponse.json({
        ...fallback,
        meta: createDebugMeta({
          fallback: true,
          fallbackReason: "schema_validation_failed",
          modeUsed: result.modeUsed,
          attemptErrors: result.attemptErrors,
        }),
      });
    }

    return NextResponse.json({
      ...validated.data,
      meta: createDebugMeta({
        fallback: false,
        modeUsed: result.modeUsed,
        attemptErrors: result.attemptErrors,
      }),
    });
  } catch (error) {
    console.error("Focus prompt generation route failed", error);
    return NextResponse.json({
      ...fallback,
      meta: createDebugMeta({
        fallback: true,
        fallbackReason: "unexpected_route_error",
        modeUsed: "none",
      }),
    });
  }
}
