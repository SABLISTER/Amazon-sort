const test = require("node:test");
const assert = require("node:assert/strict");

const parser = require("../delivery-parser.js");

const referenceDate = new Date("2026-03-19T12:00:00-04:00");

test("parses multiline delivery text with tomorrow", function () {
  const result = parser.parseDeliveryEstimate(
    "Product title\nFREE delivery\nTomorrow, Mar 20\nOnly 3 left",
    referenceDate
  );

  assert.equal(result.isKnown, true);
  assert.equal(result.date.getFullYear(), 2026);
  assert.equal(result.date.getMonth(), 2);
  assert.equal(result.date.getDate(), 20);
});

test("treats delivery in hours as same-day delivery", function () {
  const result = parser.parseDeliveryEstimate(
    "$4.99 delivery in 3 hours",
    referenceDate
  );

  assert.equal(result.isKnown, true);
  assert.equal(result.date.toISOString().slice(0, 10), "2026-03-19");
  assert.equal(result.date.getHours(), 12);
});

test("parses explicit weekday and month/day", function () {
  const result = parser.parseDeliveryEstimate(
    "Prime FREE delivery Saturday, March 21",
    referenceDate
  );

  assert.equal(result.isKnown, true);
  assert.equal(result.date.toISOString().slice(0, 10), "2026-03-21");
});

test("parses weekday-only delivery estimates", function () {
  const result = parser.parseDeliveryEstimate(
    "Get it by Tuesday",
    referenceDate
  );

  assert.equal(result.isKnown, true);
  assert.equal(result.date.toISOString().slice(0, 10), "2026-03-24");
});

test("chooses the earliest date in a delivery range", function () {
  const result = parser.parseDeliveryEstimate(
    "FREE delivery Sat, Mar 21 - Mon, Mar 24",
    referenceDate
  );

  assert.equal(result.isKnown, true);
  assert.equal(result.date.toISOString().slice(0, 10), "2026-03-21");
});

test("keeps unknown results unsortable", function () {
  const result = parser.parseDeliveryEstimate(
    "No delivery text shown on this card",
    referenceDate
  );

  assert.equal(result.isKnown, false);
  assert.equal(result.timestamp, Number.POSITIVE_INFINITY);
});
