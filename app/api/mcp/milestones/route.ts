import { NextRequest, NextResponse } from "next/server";
import { readServerState, writeServerState, markAgentDirty } from "@/lib/server-store";
import type { Milestone } from "@/lib/types";

type MilestoneCreateBody = {
  projectId: string;
  title: string;
  description?: string;
  successCriteria?: string;
};

export async function POST(req: NextRequest) {
  const state = await readServerState();
  if (!state) return NextResponse.json({ error: "No state found" }, { status: 404 });

  const body = (await req.json()) as MilestoneCreateBody;

  if (!body.projectId || !body.title?.trim()) {
    return NextResponse.json({ error: "projectId and title are required" }, { status: 400 });
  }

  const project = state.projects.find((p) => p.id === body.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const milestone: Milestone = {
    id: crypto.randomUUID(),
    projectId: body.projectId,
    title: body.title.trim(),
    description: body.description?.trim() || undefined,
    successCriteria: body.successCriteria?.trim() || undefined,
    criteriaMet: body.successCriteria?.trim() ? false : undefined,
    status: "active",
    createdAt: new Date().toISOString(),
  };

  state.milestones.push(milestone);
  await writeServerState(state);
  await markAgentDirty();
  return NextResponse.json(milestone, { status: 201 });
}

export async function GET(req: NextRequest) {
  const state = await readServerState();
  if (!state) return NextResponse.json([]);

  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");

  let milestones = state.milestones;
  if (projectId) milestones = milestones.filter((m) => m.projectId === projectId);

  const enriched = milestones.map((m) => {
    const tasks = state.tasks.filter((t) => t.milestoneId === m.id);
    return {
      ...m,
      taskStats: {
        total: tasks.length,
        todo: tasks.filter((t) => t.status === "todo").length,
        doing: tasks.filter((t) => t.status === "doing").length,
        done: tasks.filter((t) => t.status === "done").length,
      },
    };
  });

  return NextResponse.json(enriched);
}
