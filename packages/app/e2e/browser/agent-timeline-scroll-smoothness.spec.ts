import { test } from "../support/fixtures";
import { expect } from "@playwright/test";
import {
  findScrollJumps,
  expectImageSpaceReserved,
  type ScrollFrame,
  observeTimelinePages,
  openOnlyTimelineTail,
  recordUpwardTraversal,
  reportScrollJumps,
  scrollCadences,
  withVariedTimeline,
} from "../support/helpers/timeline-scroll-smoothness";

test("scroll detector distinguishes entered image growth from a simultaneous viewport jump", () => {
  const before: ScrollFrame = {
    at: 1000,
    scrollTop: 1000,
    scrollHeight: 5000,
    viewportHeight: 800,
    virtualized: true,
    loading: false,
    rows: [
      { id: "image", top: -150, height: 150 },
      { id: "reading", top: 0, height: 100 },
    ],
    anchor: "reading",
    wheelTotal: 0,
    lastWheelAt: 0,
    inputFinishedAt: null,
    imageLoads: 0,
    mounted: 0,
    unmounted: 0,
  };
  const after: ScrollFrame = {
    ...before,
    at: 1400,
    scrollTop: 900,
    wheelTotal: 100,
    lastWheelAt: 1050,
    rows: [
      { id: "image", top: -50, height: 1150 },
      { id: "reading", top: 1100, height: 100 },
    ],
  };
  expect(findScrollJumps([before, after])).toEqual([]);
  expect(
    findScrollJumps([
      { ...before, scrollTop: 200 },
      {
        ...after,
        wheelTotal: 1000,
        scrollTop: 0,
        rows: after.rows.map((row) => ({ ...row, top: row.top + 100 })),
      },
    ]),
  ).toEqual([]);
  expect(
    findScrollJumps([
      before,
      { ...after, rows: after.rows.map((row) => ({ ...row, top: row.top - 500 })) },
    ]),
  ).toHaveLength(1);
  expect(
    findScrollJumps([
      { ...before, anchor: "image", rows: [{ id: "image", top: 0, height: 150 }] },
      { ...after, rows: [{ id: "image", top: 600, height: 1150 }] },
    ]),
  ).toHaveLength(1);
});

test("scroll detector accounts for delayed wheel input and growth below the new reader", () => {
  const before: ScrollFrame = {
    at: 1000,
    scrollTop: 2000,
    scrollHeight: 5000,
    viewportHeight: 800,
    virtualized: true,
    loading: false,
    rows: [
      { id: "new-reader", top: -520, height: 278 },
      { id: "image", top: -242, height: 184 },
      { id: "old-reader", top: -58, height: 130 },
    ],
    anchor: "old-reader",
    wheelTotal: 0,
    lastWheelAt: 0,
    inputFinishedAt: null,
    imageLoads: 0,
    mounted: 0,
    unmounted: 0,
  };
  const wheel = { ...before, at: 1100, wheelTotal: 480, lastWheelAt: 1099 };
  const after: ScrollFrame = {
    ...wheel,
    at: 1220,
    scrollTop: 1520,
    scrollHeight: 5041,
    anchor: "new-reader",
    rows: [
      { id: "new-reader", top: -40, height: 278 },
      { id: "image", top: 238, height: 225 },
      { id: "old-reader", top: 463, height: 130 },
    ],
  };
  expect(findScrollJumps([before, wheel, after])).toEqual([]);
  // The previous 480 px input has already moved the viewport; the recent
  // budget includes it, but only the next 480 px belongs to this frame.
  const steadyBefore = { ...before, at: 1050, wheelTotal: 480, lastWheelAt: 1049 };
  const steadyAfter = {
    ...after,
    at: 1100,
    wheelTotal: 960,
    lastWheelAt: 1099,
    scrollHeight: 6000,
    rows: [
      { id: "new-reader", top: -40, height: 278 },
      { id: "image", top: 238, height: 1184 },
      { id: "old-reader", top: 1422, height: 130 },
    ],
  };
  expect(findScrollJumps([steadyBefore, steadyAfter])).toEqual([]);

  expect(
    findScrollJumps([
      before,
      wheel,
      {
        ...after,
        rows: after.rows.map((row) => ({ id: row.id, height: row.height, top: row.top + 100 })),
      },
    ]),
  ).toHaveLength(1);
});

test("scroll detector separates entered image resizing from compensated scroll offsets", () => {
  const before: ScrollFrame = {
    at: 74816,
    scrollTop: 2187,
    scrollHeight: 103671,
    viewportHeight: 800,
    virtualized: true,
    loading: false,
    rows: [
      { id: "image", top: -683, height: 560 },
      { id: "below-image", top: -123, height: 100 },
      { id: "reading", top: -23, height: 106 },
    ],
    anchor: "reading",
    wheelTotal: 69120,
    lastWheelAt: 74739.2,
    inputFinishedAt: null,
    imageLoads: 0,
    mounted: 3,
    unmounted: 0,
  };
  const recent = { ...before, at: 74700, wheelTotal: 68960 };
  const after: ScrollFrame = {
    ...before,
    at: 74868.2,
    scrollTop: 1896,
    scrollHeight: 104612,
    wheelTotal: 69280,
    lastWheelAt: 74838.7,
    imageLoads: 1,
    anchor: "image",
    rows: [
      { id: "image", top: -523, height: 1632 },
      { id: "below-image", top: 1109, height: 100 },
      { id: "reading", top: 1209, height: 106 },
    ],
  };
  // The image moves 160 px; scrollTop also includes 131 px of compensation.
  expect(findScrollJumps([recent, before, after])).toEqual([]);

  const shrinkBefore = {
    ...before,
    rows: [
      { id: "image", top: -692, height: 560 },
      { id: "below-image", top: -132, height: 130 },
      { id: "reading", top: -2, height: 81 },
    ],
  };
  const shrinkAfter = {
    ...after,
    scrollTop: before.scrollTop - 184,
    // The wheel arrived before this frame; its scroll update arrives now.
    wheelTotal: before.wheelTotal,
    rows: [
      { id: "image", top: -532, height: 225 },
      { id: "below-image", top: -307, height: 130 },
      { id: "reading", top: -177, height: 81 },
    ],
  };
  expect(findScrollJumps([recent, shrinkBefore, shrinkAfter])).toEqual([]);
  expect(
    findScrollJumps([
      recent,
      shrinkBefore,
      {
        ...shrinkAfter,
        rows: shrinkAfter.rows.map((row) => ({
          id: row.id,
          height: row.height,
          top: row.top - 200,
        })),
      },
    ]),
  ).toHaveLength(1);
  expect(
    findScrollJumps([
      recent,
      before,
      { ...after, rows: after.rows.map((row) => ({ ...row, top: row.top + 400 })) },
    ]),
  ).toHaveLength(1);
  expect(
    findScrollJumps([
      recent,
      before,
      {
        ...after,
        rows: after.rows.map((row) =>
          row.id === "reading" ? { ...row, top: row.top + 100 } : row,
        ),
      },
    ]),
  ).toHaveLength(1);
  expect(
    findScrollJumps([
      { ...before, inputFinishedAt: before.at - 300 },
      { ...after, inputFinishedAt: before.at - 300 },
    ]),
  ).toHaveLength(1);
  expect(
    findScrollJumps([
      recent,
      before,
      {
        ...after,
        rows: after.rows.filter((row) => row.id !== "below-image"),
      },
    ]),
  ).toHaveLength(1);
  expect(() => findScrollJumps([before, { ...after, rows: [] }])).toThrow(
    "No shared reading geometry",
  );
});

for (const cadence of scrollCadences) {
  test(`varied timeline preserves reading position during ${cadence.name} upward scrolling`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await withVariedTimeline(async (agent, newestPrompt) => {
      const pages = observeTimelinePages(page, agent.agentId);
      await openOnlyTimelineTail(page, agent, newestPrompt, pages);
      const frames = await recordUpwardTraversal(page, cadence, testInfo);
      await reportScrollJumps(page, testInfo, frames, pages);
    });
  });
}

test("reserves image space before its response arrives", async ({ page }, testInfo) => {
  await expectImageSpaceReserved(page, testInfo);
});
