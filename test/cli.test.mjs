import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, buildRequest } from "../cli/picanva.mjs";

test("push collects repeated --export and maps flags to the API body", () => {
  const { positional, flags } = parseArgs(["DAF_CHURCH_2026", "--export", "https://a.canva.com/1.png", "--export", "https://a.canva.com/2.png", "--title", "Sunday", "--pipeline", "PiPGM2", "--no-cue"]);
  const req = buildRequest("push", positional, flags);
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/v1/canva/push");
  assert.deepEqual(req.body, {
    designId: "DAF_CHURCH_2026",
    title: "Sunday",
    exportUrls: ["https://a.canva.com/1.png", "https://a.canva.com/2.png"],
    targetPipelineId: "PiPGM2",
    cueImmediately: false
  });
});

test("control sends fadeToBlack for ftb and audioEnabled for mute", () => {
  const ftb = buildRequest("control", ["ftb"], parseArgs(["--on"]).flags);
  assert.deepEqual(ftb.body, { action: "ftb", fadeToBlack: true });
  const mute = buildRequest("control", ["mute"], parseArgs(["--off", "--pipeline", "all"]).flags);
  assert.deepEqual(mute.body, { action: "mute", audioEnabled: false, targetPipelineId: "all" });
  const page = buildRequest("control", ["gotoPage"], parseArgs(["--design", "DAF_CHURCH_2026", "--page", "3"]).flags);
  assert.deepEqual(page.body, { action: "gotoPage", designId: "DAF_CHURCH_2026", pageNumber: 3 });
});

test("unknown options and missing arguments are reported", () => {
  assert.throws(() => parseArgs(["--bogus"]), /Unknown option/);
  assert.throws(() => buildRequest("push", [], parseArgs([]).flags), /design id or URL/);
  assert.throws(() => buildRequest("fly", [], parseArgs([]).flags), /Unknown command/);
});
