"use client";

import { useEffect, useRef } from "react";
import { loadState, saveState } from "@/lib/storage";
import { getInitialState, useAppStore } from "@/lib/store";
import type { AppState, Milestone, Task } from "@/lib/types";
import AppShell from "@/app/layout/AppShell";

export default function Home() {
  const hydrate = useAppStore((state) => state.hydrate);
  const saveTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const init = async () => {
      // Prefer server state so MCP agent changes are reflected on reload
      try {
        const res = await fetch("/api/mcp/sync");
        if (res.ok) {
          const serverState = await res.json();
          if (serverState) {
            hydrate(serverState);
            await saveState(serverState);
            return;
          }
        }
      } catch {
        // fall through to local storage
      }
      const stored = await loadState();
      if (stored) {
        hydrate(stored);
        return;
      }
      hydrate(getInitialState());
    };
    init();
  }, [hydrate]);

  useEffect(() => {
    const unsub = useAppStore.subscribe((state: AppState) => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
      }
      saveTimer.current = setTimeout(() => {
        saveState(state);
        // Keep server-side state in sync so MCP server sees latest data
        fetch("/api/mcp/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(state),
        }).catch(() => {});
      }, 300);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/mcp/stream");

    es.addEventListener("agent-update", (e) => {
      const server: AppState = JSON.parse(e.data);

      useAppStore.setState((current) => {
        // Tasks: newer updatedAt wins
        const serverTaskMap = new Map(server.tasks.map((t) => [t.id, t]));
        const mergedTasks: Task[] = current.tasks.map((bt) => {
          const st = serverTaskMap.get(bt.id);
          if (!st) return bt;
          const bTime = bt.updatedAt ?? bt.createdAt;
          const sTime = st.updatedAt ?? st.createdAt;
          return sTime > bTime ? st : bt;
        });
        const browserTaskIds = new Set(current.tasks.map((t) => t.id));
        server.tasks
          .filter((t) => !browserTaskIds.has(t.id))
          .forEach((t) => mergedTasks.push(t));

        // Activities: prepend server-only new entries
        const activityIds = new Set(current.activities.map((a) => a.id));
        const newActivities = server.activities.filter(
          (a) => !activityIds.has(a.id),
        );

        // Daily plans: merge taskIds into known plans, append new plans
        const browserPlanMap = new Map(current.dailyPlans.map((p) => [p.id, p]));
        const mergedPlans = server.dailyPlans.map((sp) => {
          const bp = browserPlanMap.get(sp.id);
          if (!bp) return sp;
          const knownIds = new Set(bp.taskIds);
          const added = sp.taskIds.filter((id) => !knownIds.has(id));
          return added.length ? { ...bp, taskIds: [...bp.taskIds, ...added] } : bp;
        });
        const serverPlanIds = new Set(server.dailyPlans.map((p) => p.id));
        current.dailyPlans
          .filter((p) => !serverPlanIds.has(p.id))
          .forEach((p) => mergedPlans.push(p));

        // Milestones: merge server updates into existing, append new
        const serverMilestoneMap = new Map(server.milestones.map((m) => [m.id, m]));
        const mergedMilestones: Milestone[] = current.milestones.map((bm) => {
          const sm = serverMilestoneMap.get(bm.id);
          if (!sm) return bm;
          // Server wins for criteria fields; browser wins for the rest
          const scChanged = sm.successCriteria !== bm.successCriteria;
          const cmChanged = sm.criteriaMet !== bm.criteriaMet;
          const statusChanged = sm.status !== bm.status;
          if (!scChanged && !cmChanged && !statusChanged) return bm;
          return { ...bm, successCriteria: sm.successCriteria, criteriaMet: sm.criteriaMet, status: sm.status };
        });
        const browserMilestoneIds = new Set(current.milestones.map((m) => m.id));
        server.milestones
          .filter((m) => !browserMilestoneIds.has(m.id))
          .forEach((m) => mergedMilestones.push(m));

        return {
          tasks: mergedTasks,
          activities: newActivities.length
            ? [...newActivities, ...current.activities]
            : current.activities,
          dailyPlans: mergedPlans,
          milestones: mergedMilestones,
        };
      });
    });

    return () => es.close();
  }, []);

  return <AppShell />;
}
