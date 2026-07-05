/**
 * BROWSER AUTOMATION AGENT (port 4004)
 *
 * Mocks driving a web browser for a long-running task (e.g. "fill the form
 * on site X"): 15 sequential steps, pausing at step 5 for a 2FA approval.
 * All long-running/A2A mechanics live in shared/automation-agent.ts.
 */
import "dotenv/config";
import { startAutomationAgent } from "../../shared/automation-agent.js";

const PORT = Number(process.env.BROWSER_PORT ?? 4004);

const BROWSER_ACTIONS = [
  "Launching headless browser",
  "Navigating to the target site",
  "Accepting the cookie banner",
  "Opening the login form",
  "Submitting credentials",
  "Entering the 2FA code",
  "Waiting for the dashboard to load",
  "Locating the target form",
  "Filling form fields",
  "Uploading the attachment",
  "Reviewing the summary page",
  "Clicking 'Submit'",
  "Waiting for the success banner",
  "Saving the confirmation PDF",
  "Closing the browser session",
];

startAutomationAgent({
  name: "browser-agent",
  description:
    "Browser automation sub-agent. Executes long-running web tasks step by step (mocked), reports coarse progress via tasks/get polling, and pauses in input-required state when it needs a 2FA code from the user.",
  port: PORT,
  publicUrl: process.env.BROWSER_URL ?? `http://localhost:${PORT}`,
  skill: {
    id: "browser-automation",
    name: "Browser UI automation",
    description:
      "Runs a long multi-step task in a (mock) web browser. Poll tasks/get for progress; supply the 2FA code via a message/send continuation when the task reaches input-required.",
    tags: ["automation", "browser", "long-running", "input-required"],
  },
  totalSteps: 15,
  inputRequiredAtStep: 5,
  inputPrompt: "Enter the 2FA code from your authenticator app to continue the login.",
  stepNote: (step, total) => `Step ${step}/${total}: ${BROWSER_ACTIONS[(step - 1) % BROWSER_ACTIONS.length]}`,
  resultText: (taskText, inputs) =>
    `Browser automation finished: 15/15 steps completed for task "${taskText}". ` +
    `User provided ${inputs.length} input(s) (${inputs.map((i) => `"${i}"`).join(", ")}). ` +
    `Confirmation PDF saved ✅ (mock)`,
});
