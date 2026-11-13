import assert from "node:assert/strict";
import { test } from "node:test";
import { addMonths, computeRollback, outlastsClass, planToOutlast } from "./membership";

const dayRate = 16667;
const plans = [
  { price_vnd: 500_000, duration_months: 1 },
  { price_vnd: 1_350_000, duration_months: 3 },
  { price_vnd: 2_400_000, duration_months: 6 },
];

test("addMonths clamps to the last day of a shorter month", () => {
  assert.equal(addMonths("2027-01-31", 1), "2027-02-28");
  assert.equal(addMonths("2026-11-30", 3), "2027-02-28");
  assert.equal(addMonths("2026-12-15", 1), "2027-01-15");
});

test("the membership must end strictly after the class", () => {
  assert.equal(outlastsClass("2027-01-16", "2027-01-15"), true);
  assert.equal(outlastsClass("2027-01-15", "2027-01-15"), false);
  assert.equal(outlastsClass("2027-01-14", "2027-01-15"), false);
  assert.equal(outlastsClass(null, "2027-01-15"), false);
});

test("the centre cancelling the only class refunds the whole extension", () => {
  const r = computeRollback({ fromOn: "2026-12-01", toOn: "2027-01-31", amountVnd: 1_033_000, otherClassEnd: null, today: "2026-11-15", dayRate });
  assert.deepEqual(r, { days: 62, refund_vnd: 1_033_000 });
});

test("days another class needs are kept and not refunded", () => {
  const r = computeRollback({ fromOn: "2026-12-01", toOn: "2027-01-31", amountVnd: 1_033_000, otherClassEnd: "2027-01-15", today: "2026-11-15", dayRate });
  assert.deepEqual(r, { days: 16, refund_vnd: 267_000 });
});

test("days already used are not refunded", () => {
  const r = computeRollback({ fromOn: "2026-12-01", toOn: "2026-12-31", amountVnd: 517_000, otherClassEnd: null, today: "2026-12-22", dayRate });
  assert.equal(r.days, 10);
  assert.equal(r.refund_vnd, 167_000);
});

test("the suggestion is the cheapest plan that ends after the class", () => {
  assert.equal(planToOutlast(plans, "2026-11-06", "2027-01-27")?.duration_months, 3);
  // A 3-month plan would end exactly on the class end, which is not enough.
  assert.equal(planToOutlast(plans, "2026-11-06", "2027-02-06")?.duration_months, 6);
  assert.equal(planToOutlast(plans, "2026-11-06", "2028-01-01"), null);
});
