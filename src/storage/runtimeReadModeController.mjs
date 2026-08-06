import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { RuntimeV2Parity } from "./runtimeV2Parity.mjs";

export const RUNTIME_READ_MODES = new Set(["legacy", "compare", "v2"]);

function compactReport(report) {
  if (!report) return null;
  const sections = { messages: report.messages, ...report.domains };
  return {
    generatedAt: report.generatedAt,
    summary: report.summary,
    differences: Object.fromEntries(Object.entries(sections)
      .filter(([, item]) => item.missing || item.extra || item.fieldMismatches || item.orderMismatches)
      .map(([key, item]) => [key, { missing: item.missing, extra: item.extra, fieldMismatches: item.fieldMismatches, orderMismatches: item.orderMismatches, samples: item.samples }])),
  };
}

export class RuntimeReadModeController {
  constructor({ mode = "legacy", databaseFile, intervalMs = 15 * 60 * 1000, sampleLimit = 20, authorityMode = () => "shadow", authorityHealth = () => ({ ok: true }) } = {}) {
    const requested = String(mode || "legacy").trim().toLowerCase();
    this.requestedMode = requested;
    this.configuredMode = RUNTIME_READ_MODES.has(requested) ? requested : "legacy";
    this.effectiveMode = this.configuredMode === "v2" ? "pending" : "legacy";
    this.databaseFile = databaseFile;
    this.intervalMs = Math.max(60_000, Number(intervalMs) || 15 * 60 * 1000);
    this.sampleLimit = Math.max(1, Math.min(100, Number(sampleLimit) || 20));
    this.authorityMode = authorityMode;
    this.authorityHealth = authorityHealth;
    this.startupValidation = "none";
    this.configError = RUNTIME_READ_MODES.has(requested) ? "" : `Unsupported MEMORY_HUB_RUNTIME_READ_MODE: ${requested}`;
    this.lastParity = null;
    this.lastError = "";
    this.running = false;
    this.worker = null;
    this.timer = null;
    this.stopped = false;
  }

  initialize() {
    if (this.authorityMode() === "v2") {
      const health = this.authorityHealth();
      this.startupValidation = "v2-authority-health";
      this.effectiveMode = health?.ok ? "v2" : "blocked";
      this.lastError = health?.ok ? "" : `V2 authority health failed: ${JSON.stringify(health)}`;
      return this.status();
    }
    if (this.configuredMode !== "v2") return this.status();
    try {
      this.startupValidation = "legacy-v2-parity";
      const report = new RuntimeV2Parity(this.databaseFile, { sampleLimit: this.sampleLimit }).run();
      this.lastParity = compactReport(report);
      this.effectiveMode = report.summary.ok ? "v2" : "legacy";
      this.lastError = report.summary.ok ? "" : "V2 parity failed; production reads remain on legacy";
    } catch (error) {
      this.effectiveMode = "legacy";
      this.lastError = String(error?.stack || error);
    }
    return this.status();
  }

  start() {
    if (this.configuredMode !== "compare" || this.authorityMode() === "v2") return;
    this.stopped = false;
    this.schedule(250);
  }

  schedule(delay = this.intervalMs) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.runWorker(), delay);
    this.timer.unref?.();
  }

  runWorker() {
    if (this.stopped || this.running || this.configuredMode !== "compare" || this.authorityMode() === "v2") return;
    this.running = true;
    this.lastError = "";
    const workerFile = fileURLToPath(new URL("./runtimeV2ParityWorker.mjs", import.meta.url));
    const worker = new Worker(workerFile, { workerData: { databaseFile: this.databaseFile, sampleLimit: this.sampleLimit } });
    this.worker = worker;
    let received = false;
    worker.once("message", (message) => {
      received = true;
      if (message.ok) this.lastParity = compactReport(message.report);
      else this.lastError = message.error;
    });
    worker.once("error", (error) => { this.lastError = String(error?.stack || error); });
    worker.once("exit", (code) => {
      if (!received && code && !this.lastError) this.lastError = `Parity worker exited with code ${code}`;
      this.worker = null;
      this.running = false;
      if (!this.stopped) this.schedule();
    });
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.worker?.terminate();
    this.worker = null;
    this.running = false;
  }

  usesV2Reads() {
    return this.effectiveMode === "v2";
  }

  degrade(reason) {
    if (this.effectiveMode === "v2") this.effectiveMode = this.authorityMode() === "v2" ? "blocked" : "legacy";
    this.lastError = String(reason || "V2 runtime read degraded to legacy");
    return this.status();
  }

  status() {
    return {
      requestedMode: this.requestedMode,
      configuredMode: this.configuredMode,
      effectiveMode: this.effectiveMode,
      productionSource: this.usesV2Reads() ? (this.authorityMode() === "v2" ? "v2-authority" : "v2-runtime-with-legacy-config") : "legacy",
      authorityMode: this.authorityMode(),
      startupValidation: this.startupValidation,
      compareRunning: this.running,
      intervalMs: this.intervalMs,
      configError: this.configError || null,
      lastError: this.lastError || null,
      lastParity: this.lastParity,
    };
  }

  publicStatus() {
    return {
      configuredMode: this.configuredMode,
      effectiveMode: this.effectiveMode,
      productionSource: this.usesV2Reads() ? (this.authorityMode() === "v2" ? "v2-authority" : "v2-runtime-with-legacy-config") : "legacy",
      authorityMode: this.authorityMode(),
      startupValidation: this.startupValidation,
      compareRunning: this.running,
      healthy: !this.configError && !this.lastError && (this.lastParity?.summary?.ok ?? true),
      lastParityAt: this.lastParity?.generatedAt || null,
      lastParityOk: this.lastParity?.summary?.ok ?? null,
    };
  }
}
