import { createInterface } from "node:readline";

const sessionId = "11111111-2222-4333-8444-555555555555";
process.stdout.write(`${JSON.stringify({ type: "system", session_id: sessionId })}\n`);
const lines = createInterface({ input: process.stdin });
let pendingText = "";
let approvalStep = 0;
for await (const line of lines) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message.type === "user") {
    pendingText = String(message.message?.content || "");
    process.stdout.write(`${JSON.stringify({ type: "control_request", request_id: "mcp-approval-1", request: { subtype: "can_use_tool", tool_name: "mcp__sully_memory_hub__sully_recall", input: { characterId: "char-runner", query: "test" } } })}\n`);
    continue;
  }
  if (message.type === "control_response") {
    if (approvalStep === 0) {
      if (message.response?.response?.behavior !== "allow") process.exit(3);
      approvalStep = 1;
      process.stdout.write(`${JSON.stringify({ type: "control_request", request_id: "shell-approval-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "echo unsafe" } } })}\n`);
      continue;
    }
    if (message.response?.response?.behavior !== "deny") process.exit(4);
    process.stdout.write(`${JSON.stringify({ type: "result", session_id: sessionId, result: `verbatim:${pendingText.includes("EXACT_STABLE") ? "stable" : "delta"}` })}\n`);
  }
}
