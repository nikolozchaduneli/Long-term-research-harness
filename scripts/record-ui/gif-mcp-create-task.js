/**
 * GIF: MCP agent creates a task — it appears in the browser plan in real time.
 * Browser updates via SSE. No page reload.
 *
 * Sequence: plan view (2 existing tasks) -> create_task via MCP REST API ->
 *   [~1s SSE] new task card slides into the plan
 *
 * Output: docs/ui/gif-05-mcp-create-task.gif
 */

const path = require('path');
const { launchBrowser, newPage, OUT_DIR, BASE_URL, makeRecorder } = require('./_shared');

const DEMO_PROJECT_ID = 'demo-mcp-gif';
const DEMO_MILESTONE_ID = 'demo-mcp-milestone';
const TASK_IDS = ['demo-task-a', 'demo-task-b'];

async function seedDemoProject() {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

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

async function createTask(projectId, milestoneId) {
  const res = await fetch(`${BASE_URL}/api/mcp/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId,
      milestoneId,
      title: 'Add mobile navigation menu',
      description: 'Implement hamburger menu with smooth slide-in drawer for mobile viewports',
      estimateMinutes: 50,
    }),
  });
  if (!res.ok) throw new Error(`create_task failed: ${res.status}`);
  return res.json();
}

(async () => {
  await seedDemoProject();

  const browser = await launchBrowser();
  const page = await newPage(browser);
  const { snap, encodeGif, cleanup } = makeRecorder();

  // Load app -- hydrates from seeded server state
  await page.goto(BASE_URL);
  await page.waitForLoadState('load');
  await page.waitForTimeout(2500); // allow hydration + SSE connection to settle

  // Frame: plan view, 2 existing todo tasks
  await snap(page, 2000, 'initial');
  await snap(page, 2000, 'initial2');

  // MCP agent creates a new task
  await createTask(DEMO_PROJECT_ID, DEMO_MILESTONE_ID);
  await page.waitForTimeout(1500); // SSE propagation

  // Frame: new task card appeared in plan
  await snap(page, 2500, 'task_created');
  await snap(page, 2500, 'task_created2');
  await snap(page, 2500, 'task_created3');

  await browser.close();
  encodeGif(path.join(OUT_DIR, 'gif-05-mcp-create-task.gif'));
  cleanup();
})();
