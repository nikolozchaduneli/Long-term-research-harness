import { NextResponse } from "next/server";
import { z } from "zod";
import { isConfigured, callWithFallback, extractJson } from "@/lib/ai-provider";

const requestSchema = z.object({
    projectId: z.string().min(1),
    goal: z.string().min(1),
    projectName: z.string().min(1),
    steeringNotes: z.string().optional(),
    constraints: z.object({
        timeBudgetMinutes: z.number().int().positive().optional(),
        focusNotes: z.string().optional(),
    }).optional(),
});

const milestoneSchema = z.object({
    title: z.string().min(1),
    description: z.string().min(1),
});

const responseSchema = z.object({
    milestones: z.array(milestoneSchema).min(1).max(7),
});

const fallbackMilestones = [
    {
        title: "Define core requirements and scope",
        description: "Document required outcomes, boundaries, and success criteria tied to the project goal.",
    },
    {
        title: "Complete initial prototype or draft",
        description: "Produce a working first version that demonstrates the project's main value in practice.",
    },
    {
        title: "Review and iterate based on feedback",
        description: "Validate results against the goal and refine weak areas with concrete fixes.",
    },
    {
        title: "Finalize and deliver",
        description: "Polish, verify, and package the final deliverable so it is ready for real use.",
    },
];

const buildPrompt = (payload: z.infer<typeof requestSchema>) => {
    const focusNotes = payload.constraints?.focusNotes?.trim() || "None";
    const steeringNotes = payload.steeringNotes?.trim() || "None";
    const budget = payload.constraints?.timeBudgetMinutes || "Unspecified";

    return `
Project: ${payload.projectName}
Goal: ${payload.goal}
Daily Time Budget: ${budget} minutes
Focus Notes / Constraints: ${focusNotes}
Additional Milestone Steering Guidance: ${steeringNotes}

You are an expert project planner. Break down this project's goal into 3 to 5 logical, sequential milestones.
Think hard before responding: reason carefully about scope boundaries, sequencing, and deliverable quality.

CRITICAL INSTRUCTIONS:
- Each milestone title MUST be 8 words or fewer.
- Write milestones as CONCRETE DELIVERABLES, not process descriptions.
  GOOD: "Working login page with OAuth"
  GOOD: "Database schema and seed data"
  BAD: "Define core requirements and success criteria"
  BAD: "Draft a scoped implementation plan aligned to constraints"
- Do NOT echo back the project name, goal text, or focus notes in milestone titles. Use your own words.
- The milestones MUST respect the "Focus Notes / Constraints" and "Additional Milestone Steering Guidance" above. Do not include anything outside that scope.
- If the goal is very vague (e.g. just a single word or generic phrase), produce practical starting milestones like research, prototype, and first deliverable.
- For each milestone, include a concise description (1 sentence) that grounds the title in concrete project content and expected outcome.
- Descriptions should mention what will exist or be validated once that milestone is complete.
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

    if (!isConfigured()) {
        return NextResponse.json({
            milestones: fallbackMilestones,
            meta: createDebugMeta({
                fallback: true,
                fallbackReason: "missing_ai_config",
                modeUsed: "none",
            }),
        });
    }

    try {
        const result = await callWithFallback({
            system: "You are an expert project planner. Return only valid JSON matching this structure: { \"milestones\": [{ \"title\": string, \"description\": string }] }. Return 3 to 5 milestones. No other text.",
            userContent: buildPrompt(parsed.data),
            fallbackTemperature: 0.2,
        });

        const content = result.response.text;
        if (!content) {
            return NextResponse.json({
                milestones: fallbackMilestones,
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
                milestones: fallbackMilestones,
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
                milestones: fallbackMilestones,
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
    } catch (err) {
        console.error("AI Milestone generation error", err);
        return NextResponse.json({
            milestones: fallbackMilestones,
            meta: createDebugMeta({
                fallback: true,
                fallbackReason: "unexpected_route_error",
                modeUsed: "none",
            }),
        });
    }
}
