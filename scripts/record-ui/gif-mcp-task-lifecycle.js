/**
 * GIF: MCP task lifecycle — agent picks a task (todo -> doing) then completes it (done).
 * Browser updates in real time via SSE. No page reload at any point.
 *
 * Sequence: plan view (3 todo tasks) -> pick_task (task 1 -> doing) ->
 *   [~1s SSE] task card updates -> complete_task (task 1 -> done) ->
 *   [~1s SSE] task moves to done, activity feed shows 2 agent entries
 *
 * Output: docs/ui/gif-04-mcp-task-lifecycle.gif
 */

const path = require('path');
const { launchBrowser, newPage, OUT_DIR, BASE_URL, makeRecorder } = require('./_shared');

const DEMO_PROJECT_ID = 'demo-mcp-gif';
const DEMO_MILESTONE_ID = 'demo-mcp-milestone';
const TASK_IDS = ['demo-task-a', 'demo-task-b', 'demo-task-c'];

async function seedDemoProject() {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  // Preserve existing user data; only inject/replace the demo project
  let existing = null;
  try {
    const res = await fetch(`${BASE_URL}/api/mcp/sync`);
    if (res.ok) existing = await res.json();
  } catch {}

  const merged = {
    ...(existing || { brainstormMessages: [], progressEntries: [] }),
    projects: [
      ...(existing?.projects || []).filter((p) => p.id !== DEMO_PROJECT_ID),
      {
        id: DEMO_PROJECT_ID,
        name: 'Website Redesign',
        goal: 'Redesign the company marketing site for the new brand identity',
        constraints: { timeBudgetMinutes: 240 },
        createdAt: now,
        updatedAt: now,
      },
    ],
    milestones: [
      ...(existing?.milestones || []).filter((m) => m.projectId !== DEMO_PROJECT_ID),
      {
        id: DEMO_MILESTONE_ID,
        projectId: DEMO_PROJECT_ID,
        title: 'Core pages',
        description: 'Build the landing, about, and contact pages',
        status: 'active',
        createdAt: now,
      },
    ],
    tasks: [
      ...(existing?.tasks || []).filter((t) => t.projectId !== DEMO_PROJECT_ID),
      {
        id: TASK_IDS[0],
        projectId: DEMO_PROJECT_ID,
        milestoneId: DEMO_MILESTONE_ID,
        title: 'Design hero section layout',
        description: 'Create responsive hero with value prop and primary CTA',
        estimateMinutes: 60,
        status: 'todo',
        source: 'ai',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: TASK_IDS[1],
        projectId: DEMO_PROJECT_ID,
        milestoneId: DEMO_MILESTONE_ID,
        title: 'Write homepage copy',
        description: 'Draft value prop, CTA text, and feature blurbs',
        estimateMinutes: 45,
        status: 'todo',
        source: 'ai',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: TASK_IDS[2],
        projectId: DEMO_PROJECT_ID,
        milestoneId: DEMO_MILESTONE_ID,
        title: 'Set up analytics tracking',
        description: 'Add event tracking for CTA clicks and scroll depth',
        estimateMinutes: 30,
        status: 'todo',
        source: 'ai',
        createdAt: now,
        updatedAt: now,
      },
    ],
    dailyPlans: [
      ...(existing?.dailyPlans || []).filter((p) => p.projectId !== DEMO_PROJECT_ID),
      {
        id: `${DEMO_PROJECT_ID}-${today}`,
        projectId: DEMO_PROJECT_ID,
        date: today,
        taskIds: TASK_IDS,
        timeBudgetOverrideMinutes: 240,
        createdAt: now,
      },
    ],
    activities: (existing?.activities || []).filter((a) => a.projectId !== DEMO_PROJECT_ID),
    ui: {
      ...(existing?.ui || {}),
      selectedProjectId: DEMO_PROJECT_ID,
      selectedDate: today,
      activeView: 'plan',
      planMilestoneByProject: {
        ...(existing?.ui?.planMilestoneByProject || {}),
        [DEMO_PROJECT_ID]: DEMO_MILESTONE_ID,
      },
    },
  };

  const res = await fetch(`${BASE_URL}/api/mcp/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(merged),
  });
  if (!res.ok) throw new Error(`Seed failed: ${res.status}`);
}

async function patchTask(taskId, status) {
  const res = await fetch(`${BASE_URL}/api/mcp/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`PATCH ${taskId} -> ${status} failed: ${res.status}`);
}

(async () => {
  await seedDemoProject();

  const browser = await launchBrowser();
  const page = await newPage(browser);
  const { snap, encodeGif, cleanup } = makeRecorder();

  // Load app -- hydrates from server state seeded above
  await page.goto(BASE_URL);
  await page.waitForLoadState('load');
  await page.waitForTimeout(2500); // allow hydration + SSE connection to settle

  // Frame: plan view, 3 todo tasks
  await snap(page, 2000, 'initial');
  await snap(page, 2000, 'initial2');

  // MCP agent picks task 1: todo -> doing
  await patchTask(TASK_IDS[0], 'doing');
  await page.waitForTimeout(1500); // SSE propagation

  // Frame: task 1 shows "doing"
  await snap(page, 2000, 'task_doing');
  await snap(page, 2000, 'task_doing2');

  // MCP agent completes task 1: doing -> done
  await patchTask(TASK_IDS[0], 'done');
  await page.waitForTimeout(1500); // SSE propagation

  // Frame: task 1 done, activity feed shows 2 agent entries
  await snap(page, 2500, 'task_done');
  await snap(page, 2500, 'task_done2');
  await snap(page, 2500, 'task_done3');

  await browser.close();
  encodeGif(path.join(OUT_DIR, 'gif-04-mcp-task-lifecycle.gif'));
  cleanup();
})();
