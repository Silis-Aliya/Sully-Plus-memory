import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HUB_MCP_TOOLS = new Set([
  "sully_get_character_context", "sully_get_recent_messages", "sully_recall",
  "sully_get_runtime_state", "sully_commit_activity", "sully_commit_message",
  "sully_schedule_wake", "sully_cancel_wake", "sully_list_events",
].map((name) => `mcp__sully_memory_hub__${name}`));

export class ClaudeCodeRuntime {
  constructor({ command = "claude", commandArgsPrefix = [], cwd = process.cwd(), env = process.env, model = "", permissionMode = "default", extraArgs = [], mcpConfig = "", turnTimeoutMs = 15 * 60_000, stderr = process.stderr } = {}) {
    this.command = command;
    this.commandArgsPrefix = commandArgsPrefix;
    this.cwd = cwd;
    this.env = env;
    this.model = model;
    this.permissionMode = permissionMode;
    this.extraArgs = extraArgs;
    this.mcpConfig = mcpConfig;
    this.turnTimeoutMs = turnTimeoutMs;
    this.stderr = stderr;
    this.child = null;
    this.buffer = "";
    this.sessionId = "";
    this.expectedSessionId = "";
    this.pending = null;
  }

  async connect(resumeSessionId = "") {
    if (this.child) return;
    this.expectedSessionId = UUID.test(resumeSessionId) ? resumeSessionId : "";
    const args = ["--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio"];
    if (this.permissionMode && this.permissionMode !== "default") args.push("--permission-mode", this.permissionMode);
    if (UUID.test(resumeSessionId)) args.push("--resume", resumeSessionId);
    if (this.model) args.push("--model", this.model);
    if (this.mcpConfig) args.push("--mcp-config", this.mcpConfig);
    args.push(...this.extraArgs);
    const child = spawn(this.command, [...this.commandArgsPrefix, ...args], { cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    this.child = child;
    child.stdout.on("data", (chunk) => this.consume(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => {
      const value = chunk.toString("utf8");
      if (value) this.stderr.write(`[cc-runner:claude] ${value}`);
    });
    child.once("error", (error) => this.reject(error));
    child.once("close", (code) => {
      const error = new Error(`Claude Code exited with code ${code ?? "unknown"}`);
      this.child = null;
      this.reject(error);
    });
  }

  get isAlive() {
    return Boolean(this.child);
  }

  consume(text) {
    this.buffer += text;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.session_id && UUID.test(event.session_id)) {
        const reported = event.session_id;
        const expected = this.sessionId || this.expectedSessionId;
        if (expected && reported !== expected) {
          this.reject(new Error(`Claude Code resumed unexpected session ${reported}; expected ${expected}`));
          this.close();
          continue;
        }
        this.sessionId = reported;
        this.expectedSessionId = "";
      }
      if (event.type === "control_request") this.respondControlRequest(event);
      if (event.type === "result") this.resolve({ text: typeof event.result === "string" ? event.result.trim() : "", sessionId: this.sessionId || event.session_id || "", raw: event });
    }
  }

  respondControlRequest(event) {
    const requestId = event.request_id || event.requestId;
    if (!requestId || !this.child?.stdin) return;
    const request = event.request || {};
    const allowed = request.subtype === "can_use_tool" && HUB_MCP_TOOLS.has(String(request.tool_name || ""));
    const response = allowed
      ? { behavior: "allow", updatedInput: request.input || {} }
      : { behavior: "deny", message: "Unattended runner denied this unapproved tool request." };
    this.child.stdin.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } })}\n`);
  }

  async turn(text) {
    if (!this.child?.stdin) throw new Error("Claude Code runtime is not connected");
    if (this.pending) throw new Error("Claude Code runtime already has a pending turn");
    const turnId = randomUUID();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.reject(new Error(`Claude Code turn timed out after ${this.turnTimeoutMs}ms`)), this.turnTimeoutMs);
      timer.unref?.();
      this.pending = { resolve, reject, timer, turnId };
      this.child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: String(text) } })}\n`, (error) => { if (error) this.reject(error); });
    });
  }

  resolve(value) {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(value);
  }

  reject(error) {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  close() {
    this.reject(new Error("Claude Code runtime closed"));
    if (this.child) this.child.kill();
    this.child = null;
  }
}

export function assembleWakeInput(context) {
  const stable = typeof context?.stableContext === "string" ? context.stableContext : "";
  const delta = { ...context };
  delete delta.stableContext;
  const serialized = JSON.stringify(delta, null, 2);
  return stable ? `${stable}\n\n${serialized}` : serialized;
}
