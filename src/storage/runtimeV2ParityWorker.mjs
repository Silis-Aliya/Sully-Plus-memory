import { parentPort, workerData } from "node:worker_threads";
import { RuntimeV2Parity } from "./runtimeV2Parity.mjs";

try {
  const report = new RuntimeV2Parity(workerData.databaseFile, { sampleLimit: workerData.sampleLimit || 20 }).run();
  parentPort.postMessage({ ok: true, report });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error?.stack || error) });
}
