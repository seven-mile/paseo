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
  swarmTaskBoardSchema,
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
    id: `seat-${name}`,
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
        projectWorkspaceIds: ["planner-workspace", "manager-workspace"],
        agentName: "planner.manager",
      }).map(taskIdOf),
    ).toEqual(["planner.manager"]);
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
