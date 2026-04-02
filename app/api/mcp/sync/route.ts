import { NextRequest, NextResponse } from "next/server";
import { readServerState, writeServerState } from "@/lib/server-store";
import type { AppState, Milestone, Task } from "@/lib/types";

export async function GET() {
  const state = await readServerState();
  return NextResponse.json(state);
}

export async function POST(req: NextRequest) {
  try {
    const incoming = (await req.json()) as AppState;
    const existing = await readServerState();

    // Merge: use browser state as base, but preserve any entities that MCP
    // created server-side that the browser doesn't know about yet.
    const merged: AppState = existing
      ? {
          ...incoming,
          tasks: mergeTasks(incoming.tasks, existing.tasks),
          milestones: mergeMilestones(incoming.milestones, existing.milestones),
          activities: mergeById(incoming.activities, existing.activities),
          progressEntries: mergeById(
            incoming.progressEntries,
            existing.progressEntries
          ),
        }
      : incoming;

    await writeServerState(merged);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// For tasks: use updatedAt (falling back to createdAt) to pick the winner per entity.
function mergeTasks(browser: Task[], server: Task[]): Task[] {
  const serverMap = new Map(server.map((t) => [t.id, t]));
  const result = browser.map((bt) => {
    const st = serverMap.get(bt.id);
    if (!st) return bt;
    const bTime = bt.updatedAt ?? bt.createdAt;
    const sTime = st.updatedAt ?? st.createdAt;
    return sTime > bTime ? st : bt;
  });
  const browserIds = new Set(browser.map((t) => t.id));
  server.filter((t) => !browserIds.has(t.id)).forEach((t) => result.push(t));
  return result;
}

// For milestones: use browser as base but merge in server-side field updates
// (e.g. successCriteria/criteriaMet set via MCP PATCH).
function mergeMilestones(browser: Milestone[], server: Milestone[]): Milestone[] {
  const serverMap = new Map(server.map((m) => [m.id, m]));
  const result = browser.map((bm) => {
    const sm = serverMap.get(bm.id);
    if (!sm) return bm;
    // Server always wins for criteria fields (set via MCP PATCH / evaluate_milestone).
    // Browser wins for everything else (title, description, status).
    return {
      ...sm,
      ...bm,
      successCriteria: sm.successCriteria !== undefined ? sm.successCriteria : bm.successCriteria,
      criteriaMet: sm.successCriteria !== undefined ? sm.criteriaMet : bm.criteriaMet,
    };
  });
  const browserIds = new Set(browser.map((m) => m.id));
  server.filter((m) => !browserIds.has(m.id)).forEach((m) => result.push(m));
  return result;
}

// For append-only entities: keep browser's version of known ones; append server-only ones.
function mergeById<T extends { id: string }>(browser: T[], server: T[]): T[] {
  const browserIds = new Set(browser.map((x) => x.id));
  const serverOnly = server.filter((x) => !browserIds.has(x.id));
  return [...browser, ...serverOnly];
}
