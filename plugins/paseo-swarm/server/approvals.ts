import { createHash, randomUUID } from "node:crypto";
import type { AgentRecord, Approval, ApprovalAction, SwarmState } from "../shared/models";
import { agentQualifiedName } from "../shared/models";
import { classifyCommand, type GateEvent, type GateRequest } from "./gate";
import { sendThroughMailbox } from "./mailbox";
import { approvalNotification } from "./prompts";
import { readPwa } from "./pwa";
import { readPwaSource } from "./source";
import { attachPaseo, currentPaseo, type PaseoApi } from "./runtime";
import { store } from "./state";

// How long a gated command waits for an answer before it exits as pending. Shorter than the
// two-minute default shell timeout of the common providers, so the agent sees why it stopped.
export const APPROVAL_HOLD_MS = 90_000;

const actionTitles: Record<ApprovalAction, string> = {
  push: "Push commits",
  pr_create: "Open a pull request",
  pr_ready: "Mark a pull request ready for review",
  pr_merge: "Merge a pull request",
  mr_create: "Open a merge request",
  mr_merge: "Merge a merge request",
};

export function approvalTitle(approval: Pick<Approval, "action" | "agentName">): string {
  return `${actionTitles[approval.action]} (${approval.agentName})`;
}

export interface ApprovalResolution {
  behavior: "allow" | "deny";
  message?: string;
}

type Waiter = (resolution: ApprovalResolution) => void;

export class ApprovalService {
  private readonly waiters = new Map<string, Set<Waiter>>();

  constructor(private readonly holdMs = APPROVAL_HOLD_MS) {}

  // Fail closed: an unreadable PWA gates every action.
  private gatedActions(agent: AgentRecord): readonly ApprovalAction[] | null {
    try {
      const directory = readPwaSource(agent.projectId);
      return directory ? readPwa(directory, agent.role).approvals : null;
    } catch {
      return null;
    }
  }

  readonly handle = async (
    request: GateRequest,
    emit: (event: GateEvent) => void,
    signal: AbortSignal,
  ): Promise<void> => {
    const action = classifyCommand(request.tool, request.args);
    const agent = store
      .read()
      .agents.find((candidate) => candidate.paseoAgentId === request.agentId && !candidate.retired);
    if (!action || !agent) {
      emit({ type: "decision", decision: "allow", message: "" });
      return;
    }
    const gated = this.gatedActions(agent);
    if (gated && !gated.includes(action)) {
      emit({ type: "decision", decision: "allow", message: "" });
      return;
    }
    const command = [request.tool, ...request.args];
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([agent.id, action, request.cwd, command]))
      .digest("hex");

    const approval = await this.findOrCreate(agent, action, command, request.cwd, fingerprint);
    if (approval.status === "approved") {
      await this.update(approval.id, { status: "consumed" });
      emit({ type: "decision", decision: "allow", message: "" });
      return;
    }
    emit({
      type: "held",
      approvalId: approval.id,
      message: `${approval.command.join(" ")} needs human approval (${approval.id}). Waiting for an answer.`,
    });
    const resolution = await this.wait(approval.id, signal);
    if (!resolution) {
      emit({
        type: "decision",
        decision: "pending",
        message: `Approval ${approval.id} is still pending, so the command was not run. Continue other work or end your turn; Swarm messages you when a human answers. After an approval, rerun exactly the same command from the same directory.`,
      });
      return;
    }
    if (resolution.behavior === "allow") {
      emit({ type: "decision", decision: "allow", message: "" });
      return;
    }
    emit({
      type: "decision",
      decision: "deny",
      message: `A human denied ${approval.command.join(" ")}${resolution.message ? `: ${resolution.message}` : "."}`,
    });
  };

  private async findOrCreate(
    agent: AgentRecord,
    action: ApprovalAction,
    command: string[],
    cwd: string,
    fingerprint: string,
  ): Promise<Approval> {
    let result!: Approval;
    let created = false;
    await store.commit((state) => {
      const existing = state.approvals.find(
        (candidate) =>
          candidate.fingerprint === fingerprint &&
          (candidate.status === "pending" || candidate.status === "approved"),
      );
      if (existing) {
        result = existing;
        return [];
      }
      created = true;
      result = {
        id: `approval-${randomUUID()}`,
        agentId: agent.id,
        paseoAgentId: agent.paseoAgentId,
        agentName: agentQualifiedName(agent),
        taskId: memberTaskId(state, agentQualifiedName(agent)),
        action,
        command,
        cwd,
        fingerprint,
        status: "pending",
        permissionId: null,
        feedback: null,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      };
      return [{ op: "put", collection: "approvals", record: result }];
    });
    if (created) result = await this.raise(result);
    return result;
  }

  // The permission card on the agent carries the attention push to mobile. Without it the
  // approval still waits in the inbox.
  private async raise(approval: Approval): Promise<Approval> {
    const paseo = currentPaseo();
    if (!paseo) return approval;
    try {
      const { permissionId } = await paseo.agents.ref(approval.paseoAgentId).raisePermission({
        name: `swarm_approval_${approval.action}`,
        title: approvalTitle(approval),
        description: [
          `\`${approval.command.join(" ")}\``,
          `Directory: ${approval.cwd}`,
          approval.taskId ? `Task: ${approval.taskId}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        input: { command: approval.command.join(" "), cwd: approval.cwd },
        actions: [
          { id: "approve", label: "Approve", behavior: "allow", variant: "primary" },
          { id: "deny", label: "Deny", behavior: "deny", variant: "danger" },
        ],
        metadata: { swarmApprovalId: approval.id },
      });
      return await this.update(approval.id, { permissionId });
    } catch (error) {
      console.warn(`[paseo-swarm] Could not raise a permission for ${approval.id}:`, error);
      return approval;
    }
  }

  private wait(approvalId: string, signal: AbortSignal): Promise<ApprovalResolution | null> {
    let settle!: (resolution: ApprovalResolution | null) => void;
    const result = new Promise<ApprovalResolution | null>((done) => {
      settle = done;
    });
    const waiters = this.waiters.get(approvalId) ?? new Set<Waiter>();
    this.waiters.set(approvalId, waiters);
    const finish = (resolution: ApprovalResolution | null) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abandon);
      waiters.delete(finish);
      if (waiters.size === 0) this.waiters.delete(approvalId);
      settle(resolution);
    };
    const abandon = () => finish(null);
    const timer = setTimeout(abandon, this.holdMs);
    signal.addEventListener("abort", abandon);
    waiters.add(finish);
    return result;
  }

  private async update(id: string, change: Partial<Approval>): Promise<Approval> {
    let result!: Approval;
    await store.commit((state) => {
      const current = state.approvals.find((candidate) => candidate.id === id);
      if (!current) throw new Error(`Unknown Swarm approval: ${id}`);
      result = { ...current, ...change };
      return [{ op: "put", collection: "approvals", record: result }];
    });
    return result;
  }

  // Both the agent's permission card and the inbox end here. A held command takes the answer
  // directly; otherwise the agent gets a mailbox message telling it to rerun or adjust.
  async resolve(
    approvalId: string,
    resolution: ApprovalResolution,
    paseo: PaseoApi,
    source: "inbox" | "permission" = "inbox",
  ): Promise<Approval> {
    attachPaseo(paseo);
    const current = store.read().approvals.find((candidate) => candidate.id === approvalId);
    if (!current) throw new Error(`Unknown Swarm approval: ${approvalId}`);
    if (current.status !== "pending") return current;
    const waiters = [...(this.waiters.get(approvalId) ?? [])];
    let status: Approval["status"] = "denied";
    if (resolution.behavior === "allow") status = waiters.length > 0 ? "consumed" : "approved";
    const approval = await this.update(approvalId, {
      status,
      feedback: resolution.message ?? null,
      resolvedAt: new Date().toISOString(),
    });
    for (const waiter of waiters) waiter(resolution);
    if (current.permissionId && source === "inbox") {
      // An answer from the inbox also clears the agent's permission card.
      await paseo.agents
        .ref(current.paseoAgentId)
        .respondToPermission({
          requestId: current.permissionId,
          response:
            resolution.behavior === "allow"
              ? { behavior: "allow", selectedActionId: "approve" }
              : { behavior: "deny", selectedActionId: "deny", message: resolution.message },
        })
        .catch(() => undefined);
    }
    if (waiters.length === 0) await this.notify(approval, paseo);
    return approval;
  }

  async resolvePermission(
    permissionId: string,
    resolution: ApprovalResolution,
    paseo: PaseoApi,
  ): Promise<void> {
    const approval = store
      .read()
      .approvals.find((candidate) => candidate.permissionId === permissionId);
    if (approval) await this.resolve(approval.id, resolution, paseo, "permission");
  }

  private async notify(approval: Approval, paseo: PaseoApi): Promise<void> {
    const agent = store.read().agents.find((candidate) => candidate.id === approval.agentId);
    if (!agent || agent.retired) return;
    await sendThroughMailbox(
      {
        recipientAgentId: agent.id,
        recipientName: agentQualifiedName(agent),
        senderName: "human",
        taskId: approval.taskId,
        kind: "human_activity",
        render: () => approvalNotification(approval),
      },
      { paseo },
    );
  }
}

// The Task a member is most recently working on, so the inbox can group its items.
export function memberTaskId(state: Readonly<SwarmState>, name: string): string | null {
  const tasks = state.tasks
    .filter((task) => task.workerNames.includes(name) || task.managerName === name)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return tasks.find((task) => task.workerNames.includes(name))?.id ?? tasks[0]?.id ?? null;
}

export const approvals = new ApprovalService();
