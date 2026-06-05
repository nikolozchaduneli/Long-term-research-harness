# UI Recording Scripts

Playwright scripts that capture animated GIFs of the three AI feature flows.
Run these any time the UI changes and you want to re-record.

## Prerequisites

```bash
# One-time: install the GIF encoder deps (already in package.json devDependencies)
npm install

# One-time: install Playwright's Chromium browser
npx playwright install chromium
```

> **If Playwright's npx cache hash changes** (e.g. after `npx playwright` updates),
> update the `PLAYWRIGHT_PATH` constant at the top of `_shared.js` to the new path.
> Run `npx playwright --version` to trigger a fresh download, then find the new hash
> under `%LOCALAPPDATA%\npm-cache\_npx\`.

## Usage

The app must be running locally first:

```bash
npm run dev          # starts on http://localhost:3000
```

Then run each script independently:

```bash
node scripts/record-ui/gif-drawing-board.js   # gif-01-drawing-board.gif
node scripts/record-ui/gif-plan-tasks.js      # gif-02-plan-tasks.gif
node scripts/record-ui/gif-focus-prompt.js    # gif-03-focus-prompt.gif
```

Or run all five back-to-back:

```bash
for s in gif-drawing-board gif-plan-tasks gif-focus-prompt gif-mcp-task-lifecycle gif-mcp-create-task; do
  node scripts/record-ui/$s.js
done
```

Output lands in `docs/ui/`.

> **Note for MCP scripts:** the app must be running AND `data/planner-state.json` must
> exist (i.e. you've opened the app at least once). The scripts seed a demo project
> (`demo-mcp-gif`) into your existing state, record, and leave the demo project behind.
> Delete it from Settings if you want to clean up afterwards.

## What each script records

### `gif-drawing-board.js` → `gif-01-drawing-board.gif`
Full Drawing Board conversation from scratch:
- Home page
- Empty drawing board
- Prompt typed + sent
- AI "Thinking…" → first response + canvas starts filling
- Each suggestion round: thinking flash → response → canvas updates
- "Initialize Project" button appears on canvas (hold)
- Click → Plan view lands

### `gif-plan-tasks.js` → `gif-02-plan-tasks.gif`
Task generation in Plan view:
- Plan view with no tasks (fresh project)
- First milestone selected (Active badge, accent border)
- Generate Tasks clicked → skeleton loading
- Tasks appear with time estimates + budget bar fills

### `gif-focus-prompt.js` → `gif-03-focus-prompt.gif`
Full Focus flow from Plan view:
- Skeleton loading while tasks generate
- Tasks loaded — hold so viewer can read
- Hover over first task card → Send to Focus button visible
- Click Send to Focus → auto-navigates to Focus view
- Focus view: task card at top, Generate AI Prompt button
- Click Generate AI Prompt → generating spinner
- Full AI prompt in monospace + Execution Checklist

### `gif-mcp-task-lifecycle.js` → `gif-04-mcp-task-lifecycle.gif`
Agent task lifecycle via MCP REST, browser updates in real time via SSE:
- Plan view with 3 todo tasks (seeded demo project)
- `pick_task` called via REST — task 1 flips to "doing" within ~1s, no reload
- `complete_task` called via REST — task moves to done, activity feed shows 2 agent entries

### `gif-mcp-create-task.js` → `gif-05-mcp-create-task.gif`
Agent creates a task via MCP REST, it appears live in the browser:
- Plan view with 2 existing todo tasks
- `create_task` called via REST — new task card appears in plan within ~1s, no reload

## Shared helpers (`_shared.js`)

All scripts import from `_shared.js` which owns:
- Playwright launch / page setup (1440×900)
- `waitForAI` — polls until "Thinking…" disappears
- `waitForTasksDone` — polls until skeleton is gone and task cards are present
- `waitForFocusPrompt` — polls until `<pre>` prompt block appears
- `runDrawingBoardConversation` — sends the finance tracker pitch and auto-clicks suggestions until Initialize Project is ready
- `setupProject` — Drawing Board conversation → Initialize → lands on Plan view
- `selectMilestoneAndGenerateTasks` — selects first milestone + clicks Generate Tasks
- `makeRecorder` — returns `snap(page, delay, tag)`, `encodeGif(outPath)`, `cleanup()`
