/**
 * MOBILE AUTOMATION AGENT (port 4003)
 *
 * Mocks driving a phone UI for a long-running task (e.g. "order food in the
 * XYZ app"): 20 sequential steps, pausing at step 10 for an OTP from the
 * user. All long-running/A2A mechanics live in shared/automation-agent.ts.
 */
import "dotenv/config";
import { startAutomationAgent } from "../../shared/automation-agent.js";

const PORT = Number(process.env.MOBILE_PORT ?? 4003);

const MOBILE_ACTIONS = [
  "Waking device and unlocking screen",
  "Launching the target app",
  "Waiting for home screen to render",
  "Dismissing promotional popup",
  "Tapping the search bar",
  "Typing the search query",
  "Selecting the top result",
  "Scrolling to the action button",
  "Tapping 'Continue'",
  "Reading the confirmation dialog",
  "Entering the received OTP",
  "Submitting the verification form",
  "Waiting for server confirmation",
  "Capturing the confirmation screen",
  "Verifying the on-screen status",
  "Saving a screenshot artifact",
  "Navigating back to home",
  "Closing the app",
  "Locking the device",
  "Finalizing the session report",
];

startAutomationAgent({
  name: "mobile-agent",
  description:
    "Mobile automation sub-agent. Executes long-running phone-UI tasks step by step (mocked), reports coarse progress via tasks/get polling, and pauses in input-required state when it needs an OTP from the user.",
  port: PORT,
  publicUrl: process.env.MOBILE_URL ?? `http://localhost:${PORT}`,
  skill: {
    id: "mobile-automation",
    name: "Mobile UI automation",
    description:
      "Runs a long multi-step task on a (mock) mobile device. Poll tasks/get for progress; supply the OTP via a message/send continuation when the task reaches input-required.",
    tags: ["automation", "mobile", "long-running", "input-required"],
  },
  totalSteps: 20,
  inputRequiredAtStep: 10,
  inputPrompt: "Enter the OTP shown on the device to continue the automation.",
  stepNote: (step, total) => `Step ${step}/${total}: ${MOBILE_ACTIONS[(step - 1) % MOBILE_ACTIONS.length]}`,
  resultText: (taskText, inputs) =>
    `Mobile automation finished: 20/20 UI steps completed for task "${taskText}". ` +
    `User provided ${inputs.length} input(s) (${inputs.map((i) => `"${i}"`).join(", ")}). ` +
    `Final screen: Order confirmed ✅ (mock)`,
});
