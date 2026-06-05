import { NextRequest, NextResponse } from "next/server";
import { readServerState, writeServerState, markAgentDirty } from "@/lib/server-store";
import type { Project } from "@/lib/types";

type ProjectPatchBody = {
  name?: string;
  goal?: string;
  timeBudgetMinutes?: number;
  focusNotes?: string;
};

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const state = await readServerState();
  if (!state) return NextResponse.json({ error: "No state found" }, { status: 404 });

  const projectIndex = state.projects.findIndex((project) => project.id === id);
  if (projectIndex === -1) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const body = (await req.json()) as ProjectPatchBody;
  const project = state.projects[projectIndex];

  if (typeof body.name === "string" && !body.name.trim()) {
    return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
  }

  if (typeof body.goal === "string" && !body.goal.trim()) {
    return NextResponse.json({ error: "Goal cannot be empty" }, { status: 400 });
  }

  if (
    typeof body.timeBudgetMinutes === "number" &&
    (!Number.isFinite(body.timeBudgetMinutes) || body.timeBudgetMinutes <= 0)
  ) {
    return NextResponse.json(
      { error: "timeBudgetMinutes must be a positive finite number" },
      { status: 400 },
    );
  }

  const nextConstraints =
    typeof body.timeBudgetMinutes === "number" || typeof body.focusNotes === "string"
      ? {
          ...project.constraints,
          ...(typeof body.timeBudgetMinutes === "number"
            ? { timeBudgetMinutes: body.timeBudgetMinutes }
            : {}),
          ...(typeof body.focusNotes === "string"
            ? { focusNotes: body.focusNotes.trim() || undefined }
            : {}),
        }
      : project.constraints;

  const updatedProject: Project = {
    ...project,
    ...(typeof body.name === "string" ? { name: body.name.trim() } : {}),
    ...(typeof body.goal === "string" ? { goal: body.goal.trim() } : {}),
    constraints: nextConstraints,
    updatedAt: new Date().toISOString(),
  };

  state.projects[projectIndex] = updatedProject;
  await writeServerState(state);
  await markAgentDirty();
  return NextResponse.json(updatedProject);
}
