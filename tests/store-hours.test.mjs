import assert from "node:assert/strict";
import test from "node:test";
import { storeAvailability } from "../supabase/functions/_shared/store-hours.ts";

const day = (open, close) => ({ enabled: true, open, close });
const settings = (hours, mode = "auto", timeZone = "America/Sao_Paulo") => ({ hours, mode, timeZone });
const monday = hours => settings([null, hours, null, null, null, null, null]);

test("shows today's opening before it starts and next week's after it starts", () => {
  const store = monday(day("18:00", "23:00"));
  assert.deepEqual(storeAvailability(store, new Date("2026-11-09T20:59:00Z")), {
    open: false, nextOpening: "hoje às 18:00"
  });
  assert.deepEqual(storeAvailability(store, new Date("2026-11-09T21:00:00Z")), {
    open: true, nextOpening: "segunda-feira às 18:00"
  });
  assert.equal(storeAvailability(store, new Date("2026-11-10T02:00:00Z")).open, false);
});

test("finds the next enabled day, including tomorrow and a weekly rollover", () => {
  const store = settings([day("12:00", "14:00"), null, day("18:00", "23:00")]);
  assert.equal(storeAvailability(store, new Date("2026-11-09T22:00:00Z")).nextOpening, "amanhã às 18:00");
  assert.equal(storeAvailability(store, new Date("2026-11-10T22:00:00Z")).nextOpening, "domingo às 12:00");
  assert.equal(storeAvailability(store, new Date("2026-11-15T16:00:00Z")).nextOpening, "terça-feira às 18:00");
});

test("handles overnight hours and advances the next opening after midnight", () => {
  const store = settings([null, day("18:00", "02:00"), day("18:00", "02:00")]);
  assert.deepEqual(storeAvailability(store, new Date("2026-11-10T04:30:00Z")), {
    open: true, nextOpening: "hoje às 18:00"
  });
  assert.equal(storeAvailability(store, new Date("2026-11-10T05:00:00Z")).open, false);
});

test("manual modes affect availability without pretending the scheduled opening occurred", () => {
  const hours = [null, day("18:00", "23:00"), day("18:00", "23:00")];
  const now = new Date("2026-11-09T21:01:00Z");
  assert.deepEqual(storeAvailability(settings(hours, "closed"), now), {
    open: false, nextOpening: "amanhã às 18:00"
  });
  assert.equal(storeAvailability(settings(hours, "open"), new Date("2026-11-09T15:00:00Z")).open, true);
});

test("uses the store time zone rather than the customer's local time", () => {
  const hours = [null, day("18:00", "23:00")];
  const now = new Date("2026-11-09T21:30:00Z");
  assert.equal(storeAvailability(settings(hours, "auto", "America/Sao_Paulo"), now).open, true);
  assert.deepEqual(storeAvailability(settings(hours, "auto", "America/Rio_Branco"), now), {
    open: false, nextOpening: "hoje às 18:00"
  });
});

test("does not advertise disabled, malformed or zero-length schedules", () => {
  const hours = [day("18:00", "18:00"), { enabled: false, open: "18:00", close: "23:00" }, day("25:00", "23:00")];
  assert.deepEqual(storeAvailability(settings(hours), new Date("2026-11-09T21:00:00Z")), {
    open: false, nextOpening: null
  });
  assert.deepEqual(storeAvailability(undefined, new Date("2026-11-09T21:00:00Z")), {
    open: false, nextOpening: null
  });
});
