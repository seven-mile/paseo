import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  findSwarmTaskAgent,
  isSwarmActivitySubmitShortcut,
  filterSwarmTasks,
  defaultSwarmTaskScope,
  openSwarmReply,
  openSwarmTaskSurfaceState,
  resolveSwarmTaskReference,
  scopedSwarmTasks,
  swarmTaskScopeOptions,
  swarmTaskColumns,
  swarmHumanActivityReceiptSchema,
  unansweredChoices,
  type HumanActivityInput,
  type SwarmActivity,
  type SwarmTaskAgent,
  type SwarmTaskBoard,
} from "./task-model";

function agent(name: string, parent: string | null, workspaceId: string | null): SwarmTaskAgent {
  return {
    paseoAgentId: name,
    name: name.split(".").at(-1) ?? name,
    qualifiedName: name,
    aliases: [],
    roleClass: parent ? "supervisor" : "planner",
    reportsTo: parent,
    workspaceId,
    retired: false,
  };
}
function activity(id = "question"): SwarmActivity {
  return {
    id,
    taskId: "task",
    actorName: "manager",
    actorKind: "agent",
    replyTo: null,
    responseProfile: null,
    kind: "decision",
    body: "Choose",
    data: {
      action: {
        type: "choice",
        prompt: "Which?",
        options: [{ id: "yes", label: "Yes" }],
        responseProfiles: ["steering"],
      },
    },
    refs: [],
    createdAt: "2026-10-06T00:00:00Z",
  };
}
function board(): SwarmTaskBoard {
  return {
    version: 1,
    agents: [
      agent("planner", null, "planner-workspace"),
      agent("planner.manager", "planner", "manager-workspace"),
      agent("other", null, "other-workspace"),
      agent("other.manager", "other", "other-manager-workspace"),
    ],
    tasks: ["planner.manager", "other.manager"].map((managerName) => ({
      id: managerName,
      title: managerName,
      brief: "Work",
      status: "development",
      managerName,
      workerNames: [],
      createdBy: "planner",
      updatedAt: "2026-10-06T00:00:00Z",
    })),
    activities: [],
  };
}

function taskIdOf(task: SwarmTaskBoard["tasks"][number]) {
  return task.id;
}

describe("Swarm Activity submit shortcut", () => {
  it("recognizes Ctrl/Meta Enter while leaving ordinary Enter and other chords alone", () => {
    expect(isSwarmActivitySubmitShortcut({ key: "Enter", ctrlKey: true })).toBe(true);
    expect(isSwarmActivitySubmitShortcut({ key: "Enter", metaKey: true })).toBe(true);
    expect(isSwarmActivitySubmitShortcut({ key: "Enter" })).toBe(false);
    expect(isSwarmActivitySubmitShortcut({ key: "Enter", shiftKey: true })).toBe(false);
    expect(isSwarmActivitySubmitShortcut({ key: "Enter", ctrlKey: true, shiftKey: true })).toBe(
      false,
    );
    expect(isSwarmActivitySubmitShortcut({ key: "Enter", metaKey: true, altKey: true })).toBe(
      false,
    );
    expect(isSwarmActivitySubmitShortcut({ key: "a", ctrlKey: true })).toBe(false);
  });
  it("leaves IME composition and confirmation events untouched", () => {
    expect(isSwarmActivitySubmitShortcut({ key: "Enter", ctrlKey: true, isComposing: true })).toBe(
      false,
    );
    expect(isSwarmActivitySubmitShortcut({ key: "Enter", metaKey: true, keyCode: 229 })).toBe(
      false,
    );
    expect(isSwarmActivitySubmitShortcut({ key: "Process", ctrlKey: true })).toBe(false);
  });
});

describe("Swarm Task scope", () => {
  it("filters multiple raw statuses as a union and combines them with task search", () => {
    const tasks = ["development", "review", "completed"].map((status, index) => {
      const task = board().tasks[0];
      task.id = `task-${index}`;
      task.title = index === 1 ? "Layout Review" : "Keyboard";
      task.status = status;
      return task;
    });
    expect(filterSwarmTasks(tasks, ["development", "review"], "").map(taskIdOf)).toEqual([
      "task-0",
      "task-1",
    ]);
    expect(filterSwarmTasks(tasks, ["development", "review"], " REVIEW ").map(taskIdOf)).toEqual([
      "task-1",
    ]);
    expect(filterSwarmTasks(tasks, [], "Keyboard").map(taskIdOf)).toEqual(["task-0", "task-2"]);
    expect(filterSwarmTasks(tasks, [], "")).toEqual(tasks);
    expect(filterSwarmTasks(tasks, ["unknown"], "")).toEqual([]);
  });
  it("defaults Explorer to an unambiguous live workspace planner or supervisor", () => {
    const value = board();
    expect(defaultSwarmTaskScope(value, "manager-workspace")).toBe("planner.manager");
    expect(defaultSwarmTaskScope(value, "other-workspace")).toBe("other");
    value.agents[1].retired = true;
    expect(defaultSwarmTaskScope(value, "manager-workspace")).toBe("");
    value.agents.push(agent("another", null, "planner-workspace"));
    expect(defaultSwarmTaskScope(value, "planner-workspace")).toBe("");
  });
  it("uses the focused agent's canonical nearest manager when teams share a workspace", () => {
    const value = board();
    for (const member of value.agents) member.workspaceId = "shared";
    value.agents.push({
      ...agent("planner.manager.worker", "planner.manager", "shared"),
      roleClass: "worker",
    });
    expect(defaultSwarmTaskScope(value, "shared")).toBe("");
    expect(defaultSwarmTaskScope(value, "shared", "planner.manager")).toBe("planner.manager");
    expect(defaultSwarmTaskScope(value, "shared", "planner.manager.worker")).toBe(
      "planner.manager",
    );
    expect(defaultSwarmTaskScope(value, "shared", "other")).toBe("other");
    value.agents[1].retired = true;
    expect(defaultSwarmTaskScope(value, "shared", "planner.manager.worker")).toBe("planner");
  });
  it("rejects a stale focused-agent seed from a different workspace before following ancestry", () => {
    const value = board();
    expect(defaultSwarmTaskScope(value, "planner-workspace", "other.manager")).toBe("planner");
    value.agents.push({
      ...agent("old-worker", "other.manager", "old-workspace"),
      roleClass: "worker",
    });
    expect(defaultSwarmTaskScope(value, "manager-workspace", "old-worker")).toBe("planner.manager");
  });
  it("keeps declared business columns in order, including empty stages and unknown task statuses", () => {
    const value = board();
    value.statuses = ["survey", "development", "review", "completed"];
    value.tasks[1].status = "custom";
    expect(
      swarmTaskColumns(value, value.tasks).map((column) => [
        column.status,
        column.tasks.map(taskIdOf),
      ]),
    ).toEqual([
      ["survey", []],
      ["development", ["planner.manager"]],
      ["review", []],
      ["completed", []],
      ["custom", ["other.manager"]],
    ]);
    value.statuses = undefined;
    expect(swarmTaskColumns(value, value.tasks).map((column) => column.status)).toEqual([
      "custom",
      "development",
    ]);
  });
  it("offers Project and live planner/supervisor scopes belonging to the project", () => {
    const value = board();
    expect(
      swarmTaskScopeOptions(
        value,
        ["planner-workspace", "manager-workspace"],
        ["planner-workspace", "manager-workspace", "other-workspace", "other-manager-workspace"],
      ).map((option) => option.value),
    ).toEqual(["", "planner", "planner.manager"]);
  });
  it("selects project tasks through manager ancestry across workspaces", () => {
    expect(
      scopedSwarmTasks(board(), {
        projectWorkspaceIds: ["planner-workspace"],
        plannerName: "planner",
      }).map((task) => task.id),
    ).toEqual(["planner.manager"]);
    expect(
      scopedSwarmTasks(board(), {
        projectWorkspaceIds: ["other-workspace"],
        plannerName: "planner",
      }),
    ).toEqual([]);
  });
  it("does not navigate ambiguous short names or loop through malformed ancestry", () => {
    const value = board();
    expect(findSwarmTaskAgent(value.agents, "manager")).toBeUndefined();
    value.agents[0].reportsTo = "planner.manager";
    expect(
      scopedSwarmTasks(value, {
        projectWorkspaceIds: ["planner-workspace"],
        agentName: "planner.manager",
      }),
    ).toHaveLength(1);
    expect(
      scopedSwarmTasks(value, { projectWorkspaceIds: ["planner-workspace"], agentName: "missing" }),
    ).toEqual([]);
  });
  it("uses the manager's known project before an ancestor's different project", () => {
    const value = board();
    expect(
      scopedSwarmTasks(value, {
        projectWorkspaceIds: ["planner-workspace"],
        knownWorkspaceIds: ["planner-workspace", "manager-workspace"],
      }),
    ).toEqual([]);
    expect(
      scopedSwarmTasks(value, {
        projectWorkspaceIds: ["manager-workspace"],
        knownWorkspaceIds: ["planner-workspace", "manager-workspace"],
        plannerName: "planner",
      }),
    ).toHaveLength(1);
  });
  it("shows assigned tasks for a worker and intersects planner and supervisor scope", () => {
    const value = board();
    value.agents.push({
      ...agent("planner.worker", "planner.manager", "worker-workspace"),
      roleClass: "worker",
    });
    value.tasks[0].workerNames = ["planner.worker"];
    expect(
      scopedSwarmTasks(value, {
        projectWorkspaceIds: ["planner-workspace"],
        agentName: "planner.worker",
      }),
    ).toHaveLength(1);
    expect(
      scopedSwarmTasks(value, {
        projectWorkspaceIds: ["planner-workspace"],
        plannerName: "other",
        agentName: "planner.manager",
      }),
    ).toEqual([]);
  });
});

describe("Swarm Activity reply", () => {
  it("treats a saved receipt with a notification warning as success and clears the saved reply", async () => {
    const model = openSwarmReply("task", [activity()]);
    model.replyTo("question", "yes");
    model.setBody("Saved once");
    let sends = 0;
    const send = async () => {
      sends += 1;
      return swarmHumanActivityReceiptSchema.parse({
        ...activity("saved"),
        actorKind: "human",
        data: {},
        notificationWarning: "Manager is offline",
      });
    };
    expect(await model.submit(send)).toBe(true);
    expect(model.getState()).toMatchObject({
      body: "",
      replyTo: null,
      selectedOption: null,
      pending: false,
      error: null,
      notificationWarning: "Manager is offline",
      canSubmit: false,
    });
    expect(await model.submit(send)).toBe(false);
    expect(sends).toBe(1);
    expect(model.getState().notificationWarning).toBe("Manager is offline");
  });
  it("preserves the draft, choice, and profile on failure, then emits the human response", async () => {
    const model = openSwarmReply("task", [activity()]);
    model.replyTo("question", "yes");
    model.setBody("Reason");
    expect(model.getState().responseProfile).toBe("steering");
    expect(
      await model.submit(async () => {
        throw new Error("Host offline");
      }),
    ).toBe(false);
    expect(model.getState()).toMatchObject({
      body: "Reason",
      selectedOption: "yes",
      pending: false,
      error: "Host offline",
      canSubmit: true,
    });
    const inputs: HumanActivityInput[] = [];
    expect(
      await model.submit(async (input) => {
        inputs.push(input);
      }),
    ).toBe(true);
    expect(inputs).toEqual([
      {
        taskId: "task",
        actorName: "human",
        kind: "human-response",
        body: "Selected: Yes\nReason",
        replyTo: "question",
        responseProfile: "steering",
        data: { selectedOption: "yes" },
      },
    ]);
    expect(model.getState()).toMatchObject({
      body: "",
      replyTo: null,
      pending: false,
      canSubmit: false,
    });
  });
  it("prevents duplicate sends while preserving a pending immutable payload", async () => {
    const model = openSwarmReply("task", []);
    model.setBody("Note");
    let finish = () => {};
    const pending = model.submit(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    model.setBody("Changed");
    expect(
      await model.submit(async () => {
        throw new Error("duplicate");
      }),
    ).toBe(false);
    expect(model.getState()).toMatchObject({ body: "Note", pending: true });
    finish();
    expect(await pending).toBe(true);
  });
  it("rejects stale choices and allows cancel to recover the unchanged draft as a note", async () => {
    const question = activity();
    const model = openSwarmReply("task", [question]);
    model.replyTo(question.id, "yes");
    model.setBody("My context");
    const reply = {
      ...activity("reply"),
      actorKind: "human" as const,
      replyTo: question.id,
      data: {},
    };
    model.applyActivities([question, reply]);
    expect(unansweredChoices([question, reply])).toEqual([]);
    expect(model.getState().canSubmit).toBe(false);
    model.setBody("Updated context");
    expect(model.getState().error).toMatch(/choice is no longer available/);
    expect(model.getState().canSubmit).toBe(false);
    let calls = 0;
    await model.submit(async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
    model.cancelReply();
    expect(model.getState()).toMatchObject({
      body: "Updated context",
      replyTo: null,
      selectedOption: null,
      canSubmit: true,
    });
  });
  it("refreshes mounted local errors and scopes after a language switch without changing drafts or daemon errors", async () => {
    const previousLanguage = i18n.language;
    const question = activity();
    const reply = openSwarmReply("task", [question]);
    const failed = openSwarmReply("task", []);
    const empty = openSwarmReply("task", []);
    try {
      await i18n.changeLanguage("en");
      reply.replyTo(question.id, "yes");
      reply.setBody("User-authored context");
      reply.applyActivities([]);
      const englishError = reply.getState().error;
      const englishScope = swarmTaskScopeOptions(
        board(),
        ["planner-workspace"],
        ["planner-workspace"],
      )[0].label;
      failed.setBody("Saved draft");
      await failed.submit(async () => {
        throw new Error("Raw daemon failure");
      });
      await empty.submit(async () => undefined);
      const englishBodyError = empty.getState().error;

      await i18n.changeLanguage("zh-CN");
      reply.refreshTranslations();
      failed.refreshTranslations();
      empty.refreshTranslations();
      expect(reply.getState().error).not.toBe(englishError);
      expect(reply.getState().error).not.toBe("swarm.tasks.errors.replyUnavailable");
      expect(empty.getState().error).not.toBe(englishBodyError);
      expect(empty.getState().error).not.toBe("swarm.tasks.errors.bodyRequired");
      expect(
        swarmTaskScopeOptions(board(), ["planner-workspace"], ["planner-workspace"])[0],
      ).toMatchObject({ value: "" });
      expect(
        swarmTaskScopeOptions(board(), ["planner-workspace"], ["planner-workspace"])[0].label,
      ).not.toBe(englishScope);
      expect(reply.getState()).toMatchObject({
        body: "User-authored context",
        replyTo: question.id,
        selectedOption: "yes",
        responseProfile: "steering",
        pending: false,
        canSubmit: false,
      });
      expect(failed.getState()).toMatchObject({
        body: "Saved draft",
        error: "Raw daemon failure",
        canSubmit: true,
      });
    } finally {
      reply.close();
      failed.close();
      empty.close();
      await i18n.changeLanguage(previousLanguage);
    }
  });
  it("supports ordinary replies and ignores completion after the form closes", async () => {
    const model = openSwarmReply("task", [activity()]);
    model.replyTo("question");
    model.setProfile("discussion");
    model.setBody("Discuss this");
    expect(model.getState().canSubmit).toBe(false);
    model.cancelReply();
    model.setBody("Note");
    let finish = () => {};
    const pending = model.submit(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    model.close();
    finish();
    expect(await pending).toBe(false);
  });
  it("sends an ordinary Activity reply with its selected response profile", async () => {
    const note = { ...activity(), data: {} };
    const model = openSwarmReply("task", [note]);
    model.replyTo(note.id);
    model.setProfile("discussion");
    model.setBody("Discuss this");
    const inputs: HumanActivityInput[] = [];
    expect(
      await model.submit(async (input) => {
        inputs.push(input);
      }),
    ).toBe(true);
    expect(inputs[0]).toMatchObject({
      body: "Discuss this",
      replyTo: note.id,
      responseProfile: "discussion",
      data: {},
    });
  });
});

describe("Swarm Task references", () => {
  it("resolves a cross-project Task destination through its manager's known workspace", () => {
    const value = board();
    const knownWorkspaces = [
      "planner-workspace",
      "manager-workspace",
      "other-workspace",
      "other-manager-workspace",
    ];
    expect(
      resolveSwarmTaskReference("paseo-swarm://task/other.manager", value, knownWorkspaces),
    ).toEqual({ kind: "task", taskId: "other.manager", workspaceId: "other-manager-workspace" });
    value.agents[3].workspaceId = null;
    expect(
      resolveSwarmTaskReference("paseo-swarm://task/other.manager", value, knownWorkspaces),
    ).toEqual({ kind: "task", taskId: "other.manager", workspaceId: "other-workspace" });
  });
  it("resolves brief references without Activity metadata and canonicalizes encoded file paths", () => {
    const value = board();
    expect(
      resolveSwarmTaskReference("paseo-swarm://agent/planner.manager", value, []),
    ).toMatchObject({ kind: "agent", paseoAgentId: "planner.manager" });
    expect(resolveSwarmTaskReference("paseo-swarm://task/planner.manager", value, [])).toEqual({
      kind: "task",
      taskId: "planner.manager",
    });
    expect(
      resolveSwarmTaskReference("PASEO-SWARM://FILE/manager-workspace/src%2fmain.ts", value, [
        "manager-workspace",
      ]),
    ).toEqual({ kind: "file", workspaceId: "manager-workspace", path: "src/main.ts" });
    expect(
      resolveSwarmTaskReference("paseo-swarm://file/manager-workspace/src%2Fmain.ts", value, [
        "manager-workspace",
      ]),
    ).toEqual(
      resolveSwarmTaskReference("paseo-swarm://file/manager-workspace/src/main.ts", value, [
        "manager-workspace",
      ]),
    );
  });
  it("rejects unavailable destinations, malformed escaping, and decoded traversal", () => {
    const value = board();
    for (const uri of [
      "paseo-swarm://agent/manager",
      "paseo-swarm://task/missing",
      "paseo-swarm://workspace/missing",
      "paseo-swarm://file/manager-workspace/%2E%2E/secret",
      "paseo-swarm://file/manager-workspace/%2Fetc/passwd",
      "paseo-swarm://file/manager-workspace/%ZZ",
      "paseo-swarm://file/manager-workspace/C%3A/secret",
    ])
      expect(resolveSwarmTaskReference(uri, value, ["manager-workspace"])).toBeNull();
  });
});

describe("Tasks responsive shell state", () => {
  it("reattaches the same pending reply without replay and keeps other tabs independent", async () => {
    const session = openSwarmTaskSurfaceState();
    const first = session.detail("task", [activity()]);
    first.model.replyTo("question", "yes");
    first.model.setBody("Latest committed draft");
    first.actor = "manager";
    first.selection = { start: 2, end: 5 };
    session.view = {
      selectedTaskId: "task",
      visitedTaskIds: ["task"],
      scope: "planner",
      statuses: ["development", "review"],
      search: "task",
    };
    let finish = () => {};
    const sent: HumanActivityInput[] = [];
    const pending = first.model.submit((input) => {
      sent.push(input);
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const remounted = session.detail("task", [activity()]);
    expect(remounted).toBe(first);
    expect(remounted.model.getState()).toMatchObject({
      pending: true,
      body: "Latest committed draft",
      replyTo: "question",
      selectedOption: "yes",
      responseProfile: "steering",
    });
    expect(remounted.actor).toBe("manager");
    expect(remounted.selection).toEqual({ start: 2, end: 5 });
    expect(session.view).toEqual({
      selectedTaskId: "task",
      visitedTaskIds: ["task"],
      scope: "planner",
      statuses: ["development", "review"],
      search: "task",
    });
    expect(
      await remounted.model.submit(async (input) => {
        sent.push(input);
      }),
    ).toBe(false);
    const otherTab = openSwarmTaskSurfaceState();
    expect(otherTab.detail("task", []).model.getState()).toMatchObject({
      body: "",
      pending: false,
    });
    finish();
    expect(await pending).toBe(true);
    expect(session.detail("task", []).model.getState()).toMatchObject({
      body: "",
      canSubmit: false,
    });
    expect(sent).toHaveLength(1);
    session.close();
    otherTab.close();
  });
  it("closes retained reply models only when the owning session is removed", async () => {
    const session = openSwarmTaskSurfaceState();
    const detail = session.detail("task", []);
    detail.model.setBody("Unsent");
    session.close();
    const sent: HumanActivityInput[] = [];
    expect(
      await detail.model.submit(async (input) => {
        sent.push(input);
      }),
    ).toBe(false);
    expect(sent).toEqual([]);
    expect(() => session.detail("another-task", [])).toThrow("Tasks tab state is closed");
  });
});
