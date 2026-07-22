import assert from "node:assert/strict";
import { test } from "node:test";
import type { OhlcvBar } from "@nomo/shared";
import { filterLatestSession } from "./marketData.js";

function bar(utcMs: number): OhlcvBar {
  return { time: Math.floor(utcMs / 1000), open: 1, high: 2, low: 1, close: 2, volume: 100 };
}

test("session filter keeps after-hours bars that cross UTC midnight in winter", () => {
  // January 15 in EST: the regular session and the 19:00 to 20:00 ET
  // after-hours bars belong to one session, but the after-hours bars land
  // on January 16 in UTC.
  const regular = [
    bar(Date.UTC(2026, 0, 15, 14, 30)),
    bar(Date.UTC(2026, 0, 15, 18, 0)),
    bar(Date.UTC(2026, 0, 15, 21, 0)),
  ];
  const afterHours = [bar(Date.UTC(2026, 0, 16, 0, 0)), bar(Date.UTC(2026, 0, 16, 0, 55))];
  const kept = filterLatestSession([...regular, ...afterHours]);
  assert.equal(kept.length, 5);
});

test("session filter drops bars from the previous exchange day", () => {
  const previousDay = [bar(Date.UTC(2026, 0, 14, 15, 0)), bar(Date.UTC(2026, 0, 14, 20, 0))];
  const latestDay = [bar(Date.UTC(2026, 0, 15, 14, 30)), bar(Date.UTC(2026, 0, 15, 20, 0))];
  const kept = filterLatestSession([...previousDay, ...latestDay]);
  assert.equal(kept.length, 2);
  assert.deepEqual(kept, latestDay);
});

test("session filter does not merge a premarket with the prior evening", () => {
  // 19:30 ET on January 15 is 00:30 UTC January 16; premarket at 07:00 ET
  // on January 16 is 12:00 UTC January 16. Same UTC date, different sessions.
  const priorEvening = [bar(Date.UTC(2026, 0, 16, 0, 30))];
  const premarket = [bar(Date.UTC(2026, 0, 16, 12, 0))];
  const kept = filterLatestSession([...priorEvening, ...premarket]);
  assert.deepEqual(kept, premarket);
});

test("session filter passes an empty series through", () => {
  assert.deepEqual(filterLatestSession([]), []);
});
