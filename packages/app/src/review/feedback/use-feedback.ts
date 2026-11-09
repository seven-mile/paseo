import { createElement, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  useReviewDraftComments,
  getReviewDraftComments,
  clearSentReviewDraftComments,
} from "../store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { deriveWorkspaceTabModel } from "@/screens/workspace/workspace-tab-model";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useAppSettings } from "@/hooks/use-settings";
import { dispatchComposerAgentMessage } from "@/composer/actions";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { useSessionStore, selectAgentTurnPresentation } from "@/stores/session-store";
import { FLOATING_ACTION_BUTTON_CLEARANCE } from "@/components/ui/floating-action-button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { controlHeightForLayout } from "@/components/ui/control-geometry";
import { SPACING } from "@/styles/theme";
import { i18n } from "@/i18n/i18next";
import {
  createReviewFeedbackScope,
  type FeedbackAttachment,
  type FeedbackRecipient,
} from "./index";
import { useToast } from "@/contexts/toast-context";
import { FeedbackSentMessage } from "./surface";
import { useInstalledPlugin } from "@/plugins/registry";
import { sendSeatMailById } from "@/swarm/seat-mail";

const feedbackScope = createReviewFeedbackScope();

export function useReviewFeedback(input: {
  reviewDraftKey: string;
  serverId: string;
  workspaceId?: string;
  attachment: FeedbackAttachment | null;
}) {
  const { serverId, reviewDraftKey, workspaceId } = input;
  const toast = useToast();
  const isCompact = useIsCompactFormFactor();
  const workspaceKey = workspaceId
    ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId })
    : null;
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const { settings } = useAppSettings();
  const swarm = useInstalledPlugin(serverId, "paseo-swarm");
  const comments = useReviewDraftComments(reviewDraftKey);
  const layout = useWorkspaceLayoutStore((store) =>
    workspaceKey ? store.layoutByWorkspace[workspaceKey] : undefined,
  );
  // The adapter keeps live host and diff inputs available to commands without reconstructing the workflow.
  const live = useRef({
    client,
    connected,
    attachment: input.attachment,
    sendBehavior: settings.sendBehavior,
    toast,
    swarm,
  });
  live.current = {
    client,
    connected,
    attachment: input.attachment,
    sendBehavior: settings.sendBehavior,
    toast,
    swarm,
  };
  const model = useMemo(() => {
    const showSent = (recipient: FeedbackRecipient) =>
      live.current.toast.show(
        createElement(FeedbackSentMessage, {
          recipient,
          serverId,
          workspaceId: workspaceId ?? "",
        }),
        { variant: "success" },
      );
    return feedbackScope.connect(reviewDraftKey, {
      read: () => ({
        comments: getReviewDraftComments(reviewDraftKey) ?? [],
        attachment: live.current.attachment,
        connected: live.current.connected,
        recipients: readRecipients(workspaceKey, live.current.swarm !== null),
      }),
      send: async (recipient, attachment) => {
        const { client: targetClient, sendBehavior, swarm: swarmPlugin } = live.current;
        const target = recipient.tab.target;
        if (target.kind === "swarm_seat") {
          // A seat takes mail through its mailbox, which reaches whichever agent holds it.
          if (!swarmPlugin) throw new Error(i18n.t("swarm.tasks.swarmUnavailable"));
          await sendSeatMailById(swarmPlugin, target.seatId, i18n.t("review.feedback.prompt"), [
            attachment,
          ]);
          showSent(recipient);
          return;
        }
        if (target.kind !== "agent") return;
        if (!targetClient) throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
        const activeTurnBehavior = sendBehavior === "steer" ? "steer" : "interrupt";
        await dispatchComposerAgentMessage({
          client: targetClient,
          agentId: target.agentId,
          text: i18n.t("review.feedback.prompt"),
          attachments: [attachment],
          encodeImages: async () => [],
          submission: createMessageSubmissionWriter(serverId),
          activeTurnBehavior,
          activeTurnId:
            activeTurnBehavior === "steer"
              ? (selectAgentTurnPresentation(
                  useSessionStore.getState().sessions[serverId],
                  target.agentId,
                ).turnId ?? undefined)
              : undefined,
        });
        showSent(recipient);
      },
      clearSent: (sentComments) =>
        clearSentReviewDraftComments({ key: reviewDraftKey, comments: sentComments }),
      failedMessage: () => i18n.t("review.feedback.failed"),
    });
  }, [reviewDraftKey, serverId, workspaceKey, workspaceId]);
  useEffect(() => {
    model.refresh();
  }, [model, comments, layout, connected, input.attachment, swarm]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  return {
    model,
    state,
    clearance:
      state.commentCount > 0
        ? (isCompact
            ? FLOATING_ACTION_BUTTON_CLEARANCE
            : controlHeightForLayout("md", isCompact) + SPACING[4]) + 44
        : 0,
  };
}

// The open agent tabs, and the open Swarm seat tabs while the host has Swarm.
function readRecipients(workspaceKey: string | null, includeSeats: boolean): FeedbackRecipient[] {
  const tabs = workspaceKey
    ? useWorkspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey)
    : [];
  const descriptors = deriveWorkspaceTabModel({ tabs }).tabs;
  const recipients: FeedbackRecipient[] = [];
  for (const { descriptor } of descriptors) {
    if (descriptor.target.kind === "agent") {
      recipients.push({ id: descriptor.target.agentId, tab: descriptor });
    } else if (descriptor.target.kind === "swarm_seat" && includeSeats) {
      recipients.push({ id: `swarm-seat:${descriptor.target.seatId}`, tab: descriptor });
    }
  }
  return recipients;
}
