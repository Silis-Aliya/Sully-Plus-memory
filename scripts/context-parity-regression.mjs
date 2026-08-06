import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buildContextParity } from "../contextParity.mjs";

const hash = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const goldenCases = [
  {
    name: "context-parity-p0",
    expected: {
      stable: "b2c45067f3dd003a5cd5070c99cde7ac5a1db3b5d7d944487bccdbb69f0da93a",
      volatile: "a91bedf12493da9244f031696c1387bfebc23aeafb5b31925b29911cedc2ab3a",
      activated: "4fcd1ef542bc8089b12f0e143f5b5aa053618dda1f93fe8345cbb482f8fd63cd",
      recall: "dd77bc057fe171b6374b0e87a9913e8a2a2e85691fe14a3fac806c1c628dbd85",
      finalMessages: "3aacf6388ac866fecbc7539dccda3b3317a512570e8bacc963cb2311027c469d",
      modelConfig: "2b43e751e17b736b948e44e0234ddec99261b4e2949192ae969cc911f8b9f706",
      stateChanges: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    },
  },
  {
    name: "context-parity-gates",
    expected: {
      stable: "de6d76e354a5793efe8adc9404bd2570e5599b10ad7adae14550f29a970ab323",
      volatile: "997cafe9692e1f7b91f5230530c1735083125318b15bc2e655d1da7efe9a46d9",
      activated: "3a9cfb01e803bb9b73e06105aa2e6f06433a1393fe10f85b78b8ff0471d874aa",
      recall: "ae0c74f029c549d508ead5984d09fe2c0d0721ef0a7199214ec841af5ed20b0a",
      finalMessages: "c2cb210ff18968b220303aee22960d5127e10a9e7ac4469e921beafc1e023aeb",
      modelConfig: "004185c889f8b59e94aa578126782bf0eef76d38c9b5eff5d4fcb8373d9e06ef",
      stateChanges: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    },
  },
];

const reports = [];
for (const testCase of goldenCases) {
  const fixture = JSON.parse(await readFile(new URL(`../fixtures/${testCase.name}.json`, import.meta.url), "utf8"));
  const actual = buildContextParity(fixture);
  const hashes = {
    stable: hash(actual.stableSystemPrompt), volatile: hash(actual.volatileContext), activated: hash(actual.activatedWorldbooks),
    recall: hash(actual.recallResult), finalMessages: hash(actual.finalMessages), modelConfig: hash(actual.modelConfig), stateChanges: hash(actual.stateChanges),
  };
  assert.deepEqual(hashes, testCase.expected, `Context parity drift (${testCase.name}):\n${JSON.stringify({ expected: testCase.expected, actual: hashes }, null, 2)}`);
  if (testCase.name === "context-parity-p0") {
    assert.equal(actual.chatPromptParts?.source, actual.chatPromptSource);
    assert.ok(actual.chatPromptParts?.stableRules.includes("Chat App Rules"));
    assert.ok(actual.chatPromptParts?.recencyTail.includes("最后，回到你自己"));
    assert.deepEqual(actual.activatedWorldbooks.map((item) => item.id), ["wb-before", "wb-after", "wb-author-top", "wb-author-bottom", "wb-depth", "wb-example-before", "wb-example-after"]);
    assert.ok(!actual.stableSystemPrompt.includes("记忆宫殿召回"));
    assert.ok(actual.volatileContext.indexOf("当前时间") < actual.volatileContext.indexOf("记忆宫殿召回"));
    assert.ok(actual.volatileContext.indexOf("记忆宫殿召回") < actual.volatileContext.indexOf("当前情绪底色"));
  } else {
    assert.deepEqual(actual.activatedWorldbooks.map((item) => item.id), ["wb-whole"]);
    assert.ok(actual.stableSystemPrompt.includes("[2026-08] 开始主动说明不确定性"));
    for (const stale of ["STALE_ROOM_PLATE_MUST_NOT_APPEAR", "STALE_RECALL_MUST_NOT_APPEAR", "STALE_BUFF_MUST_NOT_APPEAR"]) assert.ok(!`${actual.stableSystemPrompt}\n${actual.volatileContext}`.includes(stale));
    assert.ok(!actual.volatileContext.includes("当前时间 (Now)"));
  }
  reports.push({ fixture: testCase.name, hashes });
}
console.log(JSON.stringify({ ok: true, fixtures: reports }));
