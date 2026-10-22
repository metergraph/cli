import assert from "node:assert/strict";
import { test } from "node:test";
import { outputHoldsKnown } from "../src/read.js";

test("final output screens exact, styled and normalized credential representations", () => {
  const secret = "prefix,suffix";
  assert.equal(outputHoldsKnown(["prefix", "suffix"].join(","), [secret]), true);
  assert.equal(outputHoldsKnown("prefix,\x1b[31msuffix\x1b[0m", [secret]), true);
  assert.equal(outputHoldsKnown("prefix,\u202esuffix", [secret]), true);
  assert.equal(outputHoldsKnown("safe ordinary Metadata", [secret]), false);
  assert.equal(outputHoldsKnown("prefix suffix", [secret]), false);
});
