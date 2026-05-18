import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiffPreview } from "../ui";
import { buildThinkingSummary } from "../ui/compoments/MessageView/utils";
import { RawMode } from "../ui/contexts";

test("parseDiffPreview removes headers and classifies lines", () => {
  const lines = parseDiffPreview(
    ["--- a/file.txt", "+++ b/file.txt", "@@ -1,1 +1,1 @@", " context", "-old", "+new"].join("\n")
  );

  assert.deepEqual(lines, [
    { marker: " ", content: "context", kind: "context" },
    { marker: "-", content: "old", kind: "removed" },
    { marker: "+", content: "new", kind: "added" },
  ]);
});

test("parseDiffPreview keeps nonstandard context lines", () => {
  const lines = parseDiffPreview("...\n+added");
  assert.deepEqual(lines, [
    { marker: " ", content: "...", kind: "context" },
    { marker: "+", content: "added", kind: "added" },
  ]);
});

test("MessageView summarizes thinking content across lines", () => {
  assert.equal(
    buildThinkingSummary("Plan:\n\nInspect the code   and update tests", null, RawMode.Lite),
    "Plan: Inspect the code and update tests"
  );
});

test("MessageView removes a trailing colon from thinking summary", () => {
  assert.equal(buildThinkingSummary("Planning:", null, RawMode.Lite), "Planning");
});

test("MessageView falls back to a reasoning placeholder for hidden reasoning content in Lite mode", () => {
  assert.equal(
    buildThinkingSummary("", { reasoning_content: "hidden chain of thought" }, RawMode.Lite),
    "(reasoning...)"
  );
});

test("MessageView shows full reasoning content in Normal/Raw mode", () => {
  assert.equal(
    buildThinkingSummary("", { reasoning_content: "hidden chain of thought" }, RawMode.None),
    "hidden chain of thought"
  );
  assert.equal(
    buildThinkingSummary("", { reasoning_content: "hidden chain of thought" }, RawMode.Raw),
    "hidden chain of thought"
  );
});
