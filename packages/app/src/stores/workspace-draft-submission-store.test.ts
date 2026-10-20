import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { transformFileSync } from "@babel/core";
import { expect, test } from "vitest";
import { openSwarmCreationFormDraft } from "@/swarm/parent-selection";
import type { useWorkspaceDraftSubmissionStore } from "./workspace-draft-submission-store";

// Exercise the emitted app code: plain TypeScript execution misses Expo's omit bug.
function loadProductionStore() {
  const filename = fileURLToPath(new URL("./workspace-draft-submission-store.ts", import.meta.url));
  const caller = { name: "metro", platform: "web", isDev: false, supportsStaticESM: false };
  const result = transformFileSync(filename, {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    envName: "production",
    caller,
  });
  if (!result?.code) throw new Error("Expo produced no store code");
  const module = {
    exports: {} as { useWorkspaceDraftSubmissionStore: typeof useWorkspaceDraftSubmissionStore },
  };
  new Function("require", "module", "exports", result.code)(
    createRequire(import.meta.url),
    module,
    module.exports,
  );
  return module.exports.useWorkspaceDraftSubmissionStore;
}

test("the production app consumes a draft once and leaves other drafts pending", () => {
  const store = loadProductionStore();
  const submission = {
    serverId: "server",
    workspaceId: "workspace",
    draftId: "draft-1",
    text: "hello",
    attachments: [],
    cwd: "/repo",
    provider: "codex",
    clientMessageId: "message",
    timestamp: 1,
  } as const;
  store.getState().setPending({ ...submission, attachments: [] });
  store.getState().setPending({ ...submission, attachments: [], draftId: "draft-2" });
  expect(store.getState().consumePending({ ...submission, workspaceId: "wrong" })).toBeNull();
  expect(store.getState().consumePending(submission)).toEqual(submission);
  expect(store.getState().consumePending(submission)).toBeNull();
  expect(Object.keys(store.getState().pendingByDraftId)).toEqual(["draft-2"]);
});

test("consuming draft presentation retains its running creation through remount and retry", () => {
  const store = loadProductionStore();
  const result = new Promise<never>(() => {});
  const creation = { result, retry: () => result };
  const submission = {
    serverId: "server",
    workspaceId: "workspace",
    draftId: "draft-one",
    text: "hello",
    attachments: [],
    cwd: "/repo",
    provider: "codex",
    clientMessageId: "message",
    timestamp: 1,
    agentCreation: creation,
  };
  store.getState().setPending(submission);
  store.getState().consumePending(submission);
  expect(store.getState().pendingByDraftId[submission.draftId]).toBeUndefined();
  expect(store.getState().creationByDraftId[submission.draftId]).toBe(creation);
  store.getState().clearDraftSetup({ draftId: submission.draftId });
  expect(store.getState().creationByDraftId[submission.draftId]).toBeUndefined();
});

test("a wizard draft retains its form values through remount, with separate new intents", () => {
  const store = loadProductionStore();
  let opens = 0;
  const create = () => {
    opens += 1;
    return {
      form: openSwarmCreationFormDraft("supervisor"),
      worktreeSlug: `worktree-${opens}`,
    };
  };
  const first = store.getState().retainSwarmDraft({ draftId: "wizard-one", create });
  first.form.setName("qa-created-supervisor");
  first.form.setSelection({
    key: "host:project:supervisor",
    serverId: "host",
    roleClass: "supervisor",
    hasProject: true,
    hasResolvedProject: true,
    parent: "qa-planner",
    directory: ".",
    role: "legacy-supervisor",
  });
  first.form.setHost({ routeServerId: "host", serverId: "other-host" });
  first.form.setIsolation("worktree");
  first.form.dispatchCheckout("other-host:/work/b", {
    type: "picker-selected",
    item: {
      kind: "branch",
      name: "feature",
      refName: "refs/heads/feature",
      accessibilityLabel: "feature",
    },
  });
  const remounted = store.getState().retainSwarmDraft({ draftId: "wizard-one", create });
  expect(remounted).toBe(first);
  expect(remounted.form.getSnapshot()).toMatchObject({
    name: "qa-created-supervisor",
    selection: { parent: "qa-planner", directory: ".", role: "legacy-supervisor" },
    manualHost: { routeServerId: "host", serverId: "other-host" },
    isolation: "worktree",
    checkout: {
      targetKey: "other-host:/work/b",
      picker: { selectedItem: { refName: "refs/heads/feature" } },
    },
  });
  const other = store.getState().retainSwarmDraft({ draftId: "wizard-two", create });
  expect(other).not.toBe(first);
  expect(other.form.getSnapshot()).toEqual({
    name: "supervisor",
    selection: null,
    manualHost: null,
    projectSelection: null,
    isolation: null,
    checkout: null,
  });
  expect(opens).toBe(2);
  store.getState().clearSwarmDraft({ draftId: "wizard-one" });
  expect(store.getState().swarmByDraftId["wizard-one"]).toBeUndefined();
  expect(store.getState().swarmByDraftId["wizard-two"]).toBe(other);
  store.getState().clearDraftSetup({ draftId: "wizard-two" });
  expect(store.getState().swarmByDraftId).toEqual({});
});
