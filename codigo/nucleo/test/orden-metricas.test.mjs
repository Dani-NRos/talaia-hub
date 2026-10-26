// The order of a panel's readings: the fixed one, or the one chosen with the new ones last.
import test from "node:test";
import assert from "node:assert/strict";
import { sortMetrics } from "../src/metrics.js";

test("sortMetrics: fixed order by default, and the panel's own when there is one", () => {
  const fixed = sortMetrics(["relativeHumidity", "temperature", "batteryLevel"]);
  assert.deepEqual(sortMetrics(["relativeHumidity", "temperature", "batteryLevel"], null), fixed);
  assert.deepEqual(sortMetrics(["relativeHumidity", "temperature", "batteryLevel"], []), fixed);
  assert.deepEqual(sortMetrics(["relativeHumidity", "temperature", "batteryLevel"], ["batteryLevel", "temperature", "relativeHumidity"]), ["batteryLevel", "temperature", "relativeHumidity"]);
  // A metric without a place (it came after) goes last, in the fixed order; one that is gone is ignored.
  const out = sortMetrics(["relativeHumidity", "temperature", "batteryLevel"], ["relativeHumidity", "gone"]);
  assert.equal(out[0], "relativeHumidity");
  assert.deepEqual(out.slice(1), sortMetrics(["temperature", "batteryLevel"]));
  // It works on any iterable and doesn't change what it is given.
  const set = new Set(["temperature", "relativeHumidity"]);
  assert.deepEqual(sortMetrics(set, ["relativeHumidity"]), ["relativeHumidity", "temperature"]);
  assert.equal(set.size, 2);
});
