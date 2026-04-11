import { NextResponse } from "next/server";
import { z } from "zod";
import { isConfigured, callWithFallback, extractJson } from "@/lib/ai-provider";

const requestSchema = z.object({
  projectId: z.string().min(1),
  goal: z.string().min(1),
  projectName: z.string().optional(),
  milestoneTitle: z.string().optional(),
  milestones: z
    .array(
      z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        status: z.enum(["active", "completed"]).optional(),
      }),
    )
    .optional(),
  constraints: z.object({
    timeBudgetMinutes: z.number().int().positive().optional(),
    focusNotes: z.string().optional(),
  }),
  timeBudgetMinutes: z.number().int().positive().optional(),
  notes: z.string().optional(),
});

type GeneratedTask = {
  title: string;
  description?: string | null;
  estimateMinutes: number;
  milestoneTitle?: string | null;
};

const taskSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  estimateMinutes: z.number().int().positive().max(480),
  milestoneTitle: z.string().min(1).nullable().optional(),
});

const responseSchema = z.object({
  tasks: z.array(taskSchema).min(1),
});

const getFallbackTasks = (
  milestoneTitle?: string | null,
  milestoneList: string[] = [],
): GeneratedTask[] => {
  const trimmedMilestone = milestoneTitle?.trim();
  if (trimmedMilestone) {
    return [
      {
        title: `Clarify ${trimmedMilestone} scope`,
        description: "List in-scope deliverables and explicitly note exclusions.",
        estimateMinutes: 20,
        milestoneTitle: trimmedMilestone,
      },
      {
        title: `Define ${trimmedMilestone} success criteria`,
        description: "Write acceptance criteria and measurable outcomes for this milestone.",
        estimateMinutes: 30,
        milestoneTitle: trimmedMilestone,
      },
      {
        title: `Outline the execution plan for ${trimmedMilestone}`,
        description: "Sequence the key tasks needed to deliver this milestone.",
        estimateMinutes: 40,
        milestoneTitle: trimmedMilestone,
      },
    ];
  }
  if (milestoneList.length > 0) {
    const scoped = milestoneList.slice(0, 3);
    return scoped.map((title, index) => ({
      title: `Move ${title} forward`,
      description: `Complete one concrete next step for ${title}.`,
      estimateMinutes: [20, 30, 40][index] ?? 30,
      milestoneTitle: title,
    }));
  }
  return [
    {
      title: "Define today's target outcome",
      description: "Write a 2-3 sentence definition of success for today.",
      estimateMinutes: 15,
    },
    {
      title: "Break goal into 3 concrete steps",
      description: "List the three smallest deliverables that move the goal forward.",
      estimateMinutes: 25,
    },
    {
      title: "Deliver the first step",
      description: "Complete the most important deliverable end-to-end.",
      estimateMinutes: 60,
    },
  ];
};

const getEffectiveBudget = (payload: z.infer<typeof requestSchema>) =>
  payload.timeBudgetMinutes ?? payload.constraints.timeBudgetMinutes;

const normalizeMilestoneTitle = (value: string) => value.trim().toLowerCase();

const buildBudgetSizedTask = (
  budget: number,
  milestoneTitle?: string | null,
  seedTask?: GeneratedTask,
): GeneratedTask => {
  const estimate = Math.max(1, Math.min(30, Math.floor(budget)));
  const trimmedMilestone = milestoneTitle?.trim();

  if (seedTask) {
    return {
      ...seedTask,
      estimateMinutes: estimate,
    };
  }

  if (trimmedMilestone) {
    return {
      title: `Start ${trimmedMilestone}`,
      description: `Complete a focused first step for ${trimmedMilestone}.`,
      estimateMinutes: estimate,
      milestoneTitle: trimmedMilestone,
    };
  }

  return {
    title: "Start today's focus",
    description: "Complete one concrete step that moves the goal forward.",
    estimateMinutes: estimate,
  };
};

const enforceBudget = (
  tasks: GeneratedTask[],
  budget: number | undefined,
  milestoneTitle?: string | null,
) => {
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
    return { tasks, droppedCount: 0 };
  }

  let remaining = Math.floor(budget);
  const kept: GeneratedTask[] = [];
  let droppedCount = 0;

  for (const task of tasks) {
    if (task.estimateMinutes <= remaining) {
      kept.push(task);
      remaining -= task.estimateMinutes;
      continue;
    }
    droppedCount += 1;
  }

  if (kept.length === 0) {
    const seed = tasks[0];
    return {
      tasks: [buildBudgetSizedTask(remaining > 0 ? remaining : budget, milestoneTitle, seed)],
      droppedCount: seed ? Math.max(0, tasks.length - 1) : 0,
    };
  }

  return { tasks: kept, droppedCount };
};

const buildPrompt = (payload: z.infer<typeof requestSchema>) => {
  const focusNotes = payload.constraints.focusNotes?.trim();
  const budget = payload.timeBudgetMinutes ?? payload.constraints.timeBudgetMinutes;
  const milestoneContext = payload.milestoneTitle ? `\nTarget Milestone: ${payload.milestoneTitle}` : "";
  const milestoneDetails =
    payload.milestones
      ?.map((milestone) => {
        const title = milestone.title.trim();
        if (!title) return null;
        const description = milestone.description?.trim() || "";
        return { title, description };
      })
      .filter((milestone): milestone is { title: string; description: string } => !!milestone) ?? [];
  const milestoneList = milestoneDetails.map((milestone) => milestone.title);
  const milestoneDetailsContext =
    milestoneDetails.length > 0
      ? `\nMilestones with scope details:\n${milestoneDetails
        .map((milestone) =>
          `- ${milestone.title}: ${milestone.description || "No description provided."}`,
        )
        .join("\n")}`
      : "";
  const otherMilestones = payload.milestoneTitle
    ? milestoneList.filter((title) => title !== payload.milestoneTitle)
    : [];
  const otherMilestoneDetails = milestoneDetails.filter(
    (milestone) => !payload.milestoneTitle || milestone.title !== payload.milestoneTitle,
  );
  const milestonesContext =
    milestoneList.length > 0
      ? `\nAll milestones: ${milestoneList.join(" | ")}`
      : "";
  const otherMilestonesContext =
    otherMilestoneDetails.length > 0
      ? `\nOther milestones (avoid overlap): ${otherMilestoneDetails
        .map((milestone) =>
          milestone.description
            ? `${milestone.title} (${milestone.description})`
            : milestone.title,
        )
        .join(" | ")}`
      : "";
  const forbiddenMilestonesContext =
    otherMilestones.length > 0
      ? `\nDO NOT include tasks for these milestones: ${otherMilestones.join(" | ")}`
      : "";
  const milestoneAssignmentContext =
    !payload.milestoneTitle && milestoneList.length > 0
      ? `\nMilestone assignment requirement: every task MUST include milestoneTitle matching exactly one value from "All milestones".`
      : "";
  return `
Project: ${payload.projectName || 'Unspecified'}
Goal: ${payload.goal}${milestoneContext}${milestonesContext}${milestoneDetailsContext}${otherMilestonesContext}${forbiddenMilestonesContext}${milestoneAssignmentContext}
Time budget (minutes): ${budget ?? "unspecified"}
Focus notes: ${focusNotes || "none"}
User notes: ${payload.notes?.trim() || "none"}

Create a concise list of tasks with realistic time estimates. Keep tasks actionable and ordered.
Think hard before responding: reason carefully about dependencies, sequencing, and budget fit.
Use milestone descriptions to enforce strict scope boundaries.
For a target milestone, generate only tasks that directly advance that milestone's described outcome.
Avoid tasks whose outcome belongs to another milestone's description.
If a target milestone is provided, keep tasks tightly scoped to it and avoid tasks that belong to other milestones.
If a target milestone is provided, set milestoneTitle to that exact milestone for every task.
If no target milestone is provided and milestones are listed, set milestoneTitle for every task to one of the listed milestones.
If a time budget is provided, the SUM of estimateMinutes across all tasks must be <= that budget.`;
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

  const budget = getEffectiveBudget(parsed.data);
  const milestoneList = (parsed.data.milestones ?? [])
    .map((milestone) => milestone.title.trim())
    .filter(Boolean);
  const milestoneLookup = new Map(
    milestoneList.map((title) => [normalizeMilestoneTitle(title), title]),
  );
  const resolveMilestoneTitle = (value?: string | null) => {
    if (!value) return undefined;
    const exact = milestoneLookup.get(normalizeMilestoneTitle(value));
    return exact ?? undefined;
  };
  const getBudgetedFallback = () =>
    enforceBudget(
      getFallbackTasks(parsed.data.milestoneTitle, milestoneList),
      budget,
      parsed.data.milestoneTitle,
    );

  if (!isConfigured()) {
    const fallback = getBudgetedFallback();
    return NextResponse.json({
      tasks: fallback.tasks,
      ...(fallback.droppedCount > 0 ? { budgetWarning: { droppedCount: fallback.droppedCount } } : {}),
      meta: createDebugMeta({
        fallback: true,
        fallbackReason: "missing_ai_config",
        modeUsed: "none",
      }),
    });
  }

  try {
    const result = await callWithFallback({
      system: "You are an expert project planner. Return only valid JSON matching this structure: { \"tasks\": [{ \"title\": string, \"description\": string | null, \"estimateMinutes\": integer (5-480), \"milestoneTitle\": string | null }] }. Every task must include all four fields. No other text.",
      userContent: buildPrompt(parsed.data),
      fallbackTemperature: 0.2,
    });

    const content = result.response.text;
    if (!content) {
      const fallback = getBudgetedFallback();
      return NextResponse.json({
        tasks: fallback.tasks,
        ...(fallback.droppedCount > 0 ? { budgetWarning: { droppedCount: fallback.droppedCount } } : {}),
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
      const fallback = getBudgetedFallback();
      return NextResponse.json({
        tasks: fallback.tasks,
        ...(fallback.droppedCount > 0 ? { budgetWarning: { droppedCount: fallback.droppedCount } } : {}),
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
      const fallback = getBudgetedFallback();
      return NextResponse.json({
        tasks: fallback.tasks,
        ...(fallback.droppedCount > 0 ? { budgetWarning: { droppedCount: fallback.droppedCount } } : {}),
        meta: createDebugMeta({
          fallback: true,
          fallbackReason: "schema_validation_failed",
          modeUsed: result.modeUsed,
          attemptErrors: result.attemptErrors,
        }),
      });
    }

    const milestoneTitle = parsed.data.milestoneTitle?.trim();
    const canonicalTargetMilestoneTitle = milestoneTitle
      ? resolveMilestoneTitle(milestoneTitle) ?? milestoneTitle
      : undefined;
    const otherMilestones = milestoneTitle
      ? milestoneList.filter((title) => title.toLowerCase() !== milestoneTitle.toLowerCase())
      : [];
    let tasks: GeneratedTask[] = validated.data.tasks.map((task) => ({
      ...task,
      milestoneTitle: canonicalTargetMilestoneTitle
        ? canonicalTargetMilestoneTitle
        : resolveMilestoneTitle(task.milestoneTitle) ?? task.milestoneTitle ?? undefined,
    }));
    let filteredCount = 0;

    if (milestoneTitle && otherMilestones.length > 0) {
      const forbidden = otherMilestones.map((title) => title.toLowerCase());
      const filtered = tasks.filter((task) => {
        const haystack = `${task.title} ${task.description ?? ""}`.toLowerCase();
        return !forbidden.some((title) => haystack.includes(title));
      });
      filteredCount = tasks.length - filtered.length;
      tasks = filtered;
    }

    if (tasks.length === 0) {
      tasks = getFallbackTasks(canonicalTargetMilestoneTitle, milestoneList);
    }

    if (!canonicalTargetMilestoneTitle && milestoneList.length > 0) {
      let fallbackIndex = 0;
      tasks = tasks.map((task) => {
        if (task.milestoneTitle) return task;
        const fallbackMilestone = milestoneList[fallbackIndex % milestoneList.length];
        fallbackIndex += 1;
        return { ...task, milestoneTitle: fallbackMilestone };
      });
    }

    const budgeted = enforceBudget(tasks, budget, canonicalTargetMilestoneTitle);

    return NextResponse.json({
      tasks: budgeted.tasks,
      ...(filteredCount > 0 ? { scopeWarning: { filteredCount } } : {}),
      ...(budgeted.droppedCount > 0 ? { budgetWarning: { droppedCount: budgeted.droppedCount } } : {}),
      meta: createDebugMeta({
        fallback: false,
        modeUsed: result.modeUsed,
        attemptErrors: result.attemptErrors,
      }),
    });
  } catch {
    const fallback = getBudgetedFallback();
    return NextResponse.json({
      tasks: fallback.tasks,
      ...(fallback.droppedCount > 0 ? { budgetWarning: { droppedCount: fallback.droppedCount } } : {}),
      meta: createDebugMeta({
        fallback: true,
        fallbackReason: "unexpected_route_error",
        modeUsed: "none",
      }),
    });
  }
}
