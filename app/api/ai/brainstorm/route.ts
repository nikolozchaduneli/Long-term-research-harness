import { NextResponse } from "next/server";
import { z } from "zod";
import { isConfigured, callAi, extractJson } from "@/lib/ai-provider";

const milestoneObjectSchema = z.object({
    title: z.string(),
    description: z.string().optional(),
    successCriteria: z.string().optional(),
});

const requestSchema = z.object({
    messages: z.array(z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string()
    })),
    currentDraft: z.object({
        name: z.string().optional(),
        goal: z.string().optional(),
        milestones: z.array(z.union([z.string(), milestoneObjectSchema])).optional(),
        constraints: z.array(z.string()).optional(),
        isReady: z.boolean().optional()
    }).optional()
});

const responseSchema = z.object({
    message: z.string(),
    options: z.array(z.string()),
    updatedDraft: z.object({
        name: z.string().optional(),
        goal: z.string().optional(),
        milestones: z.array(milestoneObjectSchema).optional(),
        constraints: z.array(z.string()).optional(),
        isReady: z.boolean().optional()
    })
});

const buildSystemPrompt = (turnCount: number) => {
    return `
You are an expert project architect and brainstorm partner. Your goal is to help users turn vague ideas into concrete, actionable project definitions.

CURRENT TURN: ${turnCount} (Aim to wrap up by turn 4-5)

YOUR CORE MISSION:
1.  **Sequential Inquiry**: Ask exactly ONE high-impact question at a time. Do NOT ask about small details (microcopy, button colors, specific error messages) unless it's a very simple app.
2.  **Stopping Criterion**: Once you have a clear Name, Goal, and 3 high-level Milestones, set "isReady: true" and stop asking questions. Your goal is to be helpful, not pedantic.
3.  **Proactive Suggestions**: For every question you ask, provide exactly 3 concise multiple-choice options.
    *   **CRITICAL**: If you set "isReady: true", return an EMPTY array for "options" []. Do NOT suggest anything once it is time to build.
4.  **Surgical Update (PATCH)**: Only provide fields in "updatedDraft" that have been clarified or changed in this turn.
5.  **Completion Signal**: When you set "isReady: true", you MUST explicitly tell the user in your "message" that the project structure is complete and they can now click the "INITIALIZE PROJECT" button to start building.

MILESTONE RULES:
- Milestones should be CONCRETE DELIVERABLES.
- If you have enough info, GENERATE the milestones yourself and ask if they look good, rather than asking the user to define them.
- Each milestone MUST be an object with: "title" (required), "description" (1-2 sentence scope summary), and "successCriteria" (a clear, testable condition for completion).

OUTPUT FORMAT — you MUST return valid JSON and nothing else:
{
  "message": "Friendly response. If isReady is true, tell the user the project is ready to build!",
  "options": ["Choice A", "Choice B", "Choice C"],
  "updatedDraft": {
    "milestones": [
      {
        "title": "Core MVP",
        "description": "Basic working version with essential features",
        "successCriteria": "Users can create, edit, and delete items end-to-end"
      }
    ]
  }
}
`;
};

export async function POST(request: Request) {
    const body = await request.json().catch(() => null);
    const parsed = requestSchema.safeParse(body);

    if (!parsed.success) {
        return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    if (!isConfigured()) {
        return NextResponse.json({
            message: "AI configuration missing. I'm operating in offline mode. How can I help?",
            updatedDraft: parsed.data.currentDraft || { name: "", goal: "", milestones: [], constraints: [] }
        });
    }

    const conversationContext = parsed.data.messages
        .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
        .join("\n");

    const turnCount = Math.floor(parsed.data.messages.filter(m => m.role === "user").length);
    const draftContext = parsed.data.currentDraft ? `CURRENT DRAFT: ${JSON.stringify(parsed.data.currentDraft)}` : "NO DRAFT YET";

    try {
        const result = await callAi({
            system: buildSystemPrompt(turnCount),
            userContent: `${draftContext}\n\nCONVERSATION HISTORY:\n${conversationContext}`,
            maxTokens: 16384,
        });

        const content = result.text;
        const thinkingText = result.thinkingText;
        if (!content) throw new Error("No content in response");

        const parsed_result = extractJson(content);
        const validated = responseSchema.safeParse(parsed_result);
        if (!validated.success) throw new Error("Invalid output format");

        return NextResponse.json({
            ...validated.data,
            thinkingText: thinkingText || undefined,
        });
    } catch (err) {
        console.error("Brainstorm error", err);
        return NextResponse.json({
            message: "I'm having trouble connecting to my creative gears. Can you try again?",
            updatedDraft: parsed.data.currentDraft || { name: "", goal: "", milestones: [], constraints: [] }
        });
    }
}
