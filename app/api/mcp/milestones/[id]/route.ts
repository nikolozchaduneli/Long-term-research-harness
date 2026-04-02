import { NextRequest, NextResponse } from "next/server";
import { readServerState, writeServerState, markAgentDirty } from "@/lib/server-store";
import type { Milestone } from "@/lib/types";

type MilestonePatchBody = {
  title?: string;
  description?: string;
  successCriteria?: string;
  criteriaMet?: boolean;
  status?: Milestone["status"];
};

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const state = await readServerState();
  if (!state) return NextResponse.json({ error: "No state found" }, { status: 404 });

  const milestoneIndex = state.milestones.findIndex((milestone) => milestone.id === id);
  if (milestoneIndex === -1) {
    return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
  }

  const body = (await req.json()) as MilestonePatchBody;
  const milestone = state.milestones[milestoneIndex];

  if (body.status && !["active", "completed"].includes(body.status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  if (typeof body.title === "string" && !body.title.trim()) {
    return NextResponse.json({ error: "Title cannot be empty" }, { status: 400 });
  }

  const nextSuccessCriteria =
    typeof body.successCriteria === "string"
      ? body.successCriteria.trim() || undefined
      : milestone.successCriteria;

  let nextCriteriaMet = milestone.criteriaMet;
  if (typeof body.successCriteria === "string") {
    nextCriteriaMet = nextSuccessCriteria
      ? typeof body.criteriaMet === "boolean"
        ? body.criteriaMet
        : milestone.successCriteria
          ? milestone.criteriaMet ?? false
          : false
      : undefined;
  } else if (typeof body.criteriaMet === "boolean") {
    nextCriteriaMet = nextSuccessCriteria ? body.criteriaMet : undefined;
  }

  const nextStatus = body.status ?? milestone.status;
  if (nextStatus === "completed" && nextSuccessCriteria && nextCriteriaMet !== true) {
    return NextResponse.json(
      { error: "Success criteria must be met before completing this milestone" },
      { status: 400 },
    );
  }

  const updatedMilestone: Milestone = {
    ...milestone,
    ...(typeof body.title === "string" ? { title: body.title.trim() } : {}),
    ...(typeof body.description === "string"
      ? { description: body.description.trim() || undefined }
      : {}),
    ...(typeof body.successCriteria === "string"
      ? { successCriteria: nextSuccessCriteria }
      : {}),
    ...(typeof body.successCriteria === "string" || typeof body.criteriaMet === "boolean"
      ? { criteriaMet: nextCriteriaMet }
      : {}),
    status: nextStatus,
  };

  state.milestones[milestoneIndex] = updatedMilestone;
  await writeServerState(state);
  await markAgentDirty();
  return NextResponse.json(updatedMilestone);
}
