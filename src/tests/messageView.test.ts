import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiffPreview } from "../ui/MessageView";

test("parseDiffPreview removes headers and classifies lines", () => {
  const lines = parseDiffPreview([
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1,1 +1,1 @@",
    " context",
    "-old",
    "+new"
  ].join("\n"));

  assert.deepEqual(lines, [
    { marker: " ", content: "context", kind: "context" },
    { marker: "-", content: "old", kind: "removed" },
    { marker: "+", content: "new", kind: "added" }
  ]);
});

test("parseDiffPreview keeps nonstandard context lines", () => {
  const lines = parseDiffPreview("...\n+added");
  assert.deepEqual(lines, [
    { marker: " ", content: "...", kind: "context" },
    { marker: "+", content: "added", kind: "added" }
  ]);
});
