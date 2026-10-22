import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  getEventLogPath,
  getLegacyStatePath,
  getSnapshotPath,
  StateLoadError,
  StateStore,
} from "../server/state";
import { emptyState, type Task } from "../shared/models";

function task(id: string, status = "survey"): Task {
  return {
    id,
    title: id,
    brief: id,
    status,
    managerName: "planner",
    workerNames: [],
    createdBy: "planner",
    data: {},
    createdAt: "2026-10-22T00:00:00Z",
    updatedAt: "2026-10-22T00:00:00Z",
  };
}

function withHome(run: (home: string) => Promise<void>) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-state-"));
    const previous = process.env.PASEO_HOME;
    process.env.PASEO_HOME = home;
    try {
      await run(home);
    } finally {
      if (previous === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

const read = (path: string) => readFileSync(path, "utf8");

test(
  "a corrupt legacy state.json fails loudly and is never overwritten",
  withHome(async () => {
    mkdirSync(dirname(getLegacyStatePath()), { recursive: true });
    writeFileSync(getLegacyStatePath(), '{"version": 1, "agents": [');
    const store = new StateStore();
    assert.throws(() => store.read(), StateLoadError);
    await assert.rejects(
      store.commit(() => [{ op: "put", collection: "tasks", record: task("a") }]),
      /state\.json cannot be read/,
    );
    assert.equal(read(getLegacyStatePath()), '{"version": 1, "agents": [');
    assert.equal(existsSync(getSnapshotPath()), false);
    assert.equal(existsSync(getEventLogPath()), false);
  }),
);

test(
  "a valid legacy state.json is imported into a snapshot once",
  withHome(async () => {
    mkdirSync(dirname(getLegacyStatePath()), { recursive: true });
    writeFileSync(getLegacyStatePath(), JSON.stringify({ ...emptyState(), tasks: [task("a")] }));
    assert.deepEqual(
      new StateStore().read().tasks.map((value) => value.id),
      ["a"],
    );
    assert.equal(existsSync(getLegacyStatePath()), false);
    assert.equal(existsSync(`${getLegacyStatePath()}.imported`), true);
    assert.deepEqual(
      new StateStore().read().tasks.map((value) => value.id),
      ["a"],
    );
  }),
);

test(
  "commits append one line each and replay in a fresh store",
  withHome(async () => {
    const store = new StateStore();
    await store.commit(() => [{ op: "put", collection: "tasks", record: task("a") }]);
    await store.commit(() => [{ op: "put", collection: "tasks", record: task("b") }]);
    await store.commit(() => [{ op: "put", collection: "tasks", record: task("a", "done") }]);
    await store.commit(() => [{ op: "delete", collection: "tasks", key: "b" }]);
    assert.equal(read(getEventLogPath()).trim().split("\n").length, 4);
    assert.deepEqual(new StateStore().read().tasks, [task("a", "done")]);
    // Loading folds the log into the snapshot.
    assert.equal(read(getEventLogPath()), "");
    assert.deepEqual(new StateStore().read().tasks, [task("a", "done")]);
  }),
);

test(
  "a rejected plan or invalid record changes neither memory nor disk",
  withHome(async () => {
    const store = new StateStore();
    await store.commit(() => [{ op: "put", collection: "tasks", record: task("a") }]);
    const before = read(getEventLogPath());
    await assert.rejects(
      store.commit(() => {
        throw new Error("validation failed");
      }),
      /validation failed/,
    );
    await assert.rejects(
      store.commit(() => [
        { op: "put", collection: "tasks", record: task("b") },
        { op: "put", collection: "tasks", record: { ...task("c"), id: "Not A Slug" } },
      ]),
    );
    assert.equal(read(getEventLogPath()), before);
    assert.deepEqual(store.read().tasks, [task("a")]);
  }),
);

test(
  "an unterminated final line is dropped; corruption elsewhere fails loudly",
  withHome(async () => {
    const store = new StateStore();
    await store.commit(() => [{ op: "put", collection: "tasks", record: task("a") }]);
    writeFileSync(getEventLogPath(), read(getEventLogPath()) + '{"seq":2,"at":"x","chan');
    assert.deepEqual(
      new StateStore().read().tasks.map((value) => value.id),
      ["a"],
    );

    const next = new StateStore();
    await next.commit(() => [{ op: "put", collection: "tasks", record: task("b") }]);
    const log = read(getEventLogPath());
    writeFileSync(getEventLogPath(), "not json\n" + log);
    assert.throws(() => new StateStore().read(), /events\.jsonl cannot be read \(line 1/);
    assert.equal(read(getEventLogPath()), "not json\n" + log);
  }),
);

test(
  "compaction folds the log into the snapshot and tolerates a crash before truncation",
  withHome(async () => {
    const store = new StateStore(2);
    await store.commit(() => [{ op: "put", collection: "tasks", record: task("a") }]);
    const firstCommit = read(getEventLogPath());
    await store.commit(() => [{ op: "put", collection: "tasks", record: task("b") }]);
    assert.equal(read(getEventLogPath()), "");
    assert.equal(JSON.parse(read(getSnapshotPath())).seq, 2);
    // Simulate a crash after the snapshot rename but before the log truncation.
    writeFileSync(getEventLogPath(), firstCommit);
    assert.deepEqual(
      new StateStore().read().tasks.map((value) => value.id),
      ["a", "b"],
    );
    const later = new StateStore();
    await later.commit(() => [{ op: "put", collection: "tasks", record: task("c") }]);
    assert.deepEqual(
      new StateStore().read().tasks.map((value) => value.id),
      ["a", "b", "c"],
    );
  }),
);

test(
  "a corrupt snapshot fails loudly",
  withHome(async () => {
    mkdirSync(dirname(getSnapshotPath()), { recursive: true });
    writeFileSync(getSnapshotPath(), "{}");
    assert.throws(() => new StateStore().read(), /snapshot\.json cannot be read/);
    assert.equal(read(getSnapshotPath()), "{}");
  }),
);
