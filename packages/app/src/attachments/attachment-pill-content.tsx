import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import React from "react";
import {
  CircleDot,
  FileText,
  GitPullRequest,
  Image as ImageIcon,
  MessageSquareCode,
  MousePointer2,
} from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { AgentAttachment, UserMessageAttachmentSummary } from "@getpaseo/protocol/messages";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import { getFileTypeLabel } from "@/attachments/file-types";
import { isPullRequestContextAttachment } from "@/attachments/workspace-attachment-utils";
import { getForgePresentation } from "@/git/forge";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { formatFileSize } from "@/utils/format-file-size";

export interface AttachmentPillContent {
  icon: ReactNode;
  title: string;
  subtitle: string;
}

function getReviewSubtitle(count: number, t: TFunction): string {
  return count === 1
    ? t("message.attachments.commentsOne")
    : t("message.attachments.commentsMany", { count });
}

function getPullRequestContextSubtitle(attachment: WorkspaceComposerAttachment): string {
  if (
    attachment.kind === "forge.change_request_check" ||
    attachment.kind === "github.pull_request_check"
  ) {
    return "Check logs";
  }
  if (
    attachment.kind === "forge.change_request_comment" ||
    attachment.kind === "github.pull_request_comment"
  ) {
    return "Comment";
  }
  return "Review";
}

function getTextAttachmentSubtitle(
  attachment: Extract<AgentAttachment, { type: "text" }>,
  t: TFunction,
): string {
  if (attachment.contextKind === "chat_history") {
    return "Previous conversation";
  }
  return t("message.attachments.text");
}

export function getAgentAttachmentPillContent(
  attachment: AgentAttachment,
  t: TFunction,
): AttachmentPillContent {
  switch (attachment.type) {
    case "review":
      return {
        icon: attachmentReviewIcon,
        title: t("message.attachments.review"),
        subtitle: getReviewSubtitle(attachment.comments.length, t),
      };
    case "forge_change_request": {
      const presentation = getForgePresentation(attachment.forge ?? "github");
      return {
        icon: attachmentGithubPrIcon,
        title: attachment.title,
        subtitle: `${presentation.changeRequestAbbrev} ${presentation.numberPrefix}${attachment.number}`,
      };
    }
    case "github_pr":
      return {
        icon: attachmentGithubPrIcon,
        title: attachment.title,
        subtitle: `PR #${attachment.number}`,
      };
    case "forge_issue":
    case "github_issue":
      return {
        icon: attachmentGithubIssueIcon,
        title: attachment.title,
        subtitle: `Issue #${attachment.number}`,
      };
    case "text":
      if (attachment.externalResource) {
        return {
          icon: attachmentGithubIssueIcon,
          title: attachment.externalResource.title,
          subtitle: `${attachment.externalResource.providerLabel} ${attachment.externalResource.identifier}`,
        };
      }
      return {
        icon: attachmentFileIcon,
        title: attachment.title ?? t("message.attachments.textAttachment"),
        subtitle: getTextAttachmentSubtitle(attachment, t),
      };
    case "uploaded_file":
      return {
        icon: attachmentFileIcon,
        title: attachment.fileName,
        subtitle: getFileTypeLabel(attachment.fileName) ?? t("message.attachments.file"),
      };
  }
}

function getImageSummaryPillContent(
  summary: UserMessageAttachmentSummary,
  t: TFunction,
): AttachmentPillContent {
  const format = summary.mimeType?.split("/")[1]?.toUpperCase();
  const size = summary.size === undefined ? undefined : formatFileSize(summary.size);
  return {
    icon: attachmentImageIcon,
    title: t("message.attachments.image"),
    subtitle: [format, size].filter(Boolean).join(" · "),
  };
}

function getTextSummaryPillContent(
  summary: UserMessageAttachmentSummary,
  t: TFunction,
): AttachmentPillContent {
  if (summary.providerLabel || summary.identifier) {
    return {
      icon: attachmentGithubIssueIcon,
      title: summary.title ?? t("message.attachments.textAttachment"),
      subtitle: [summary.providerLabel, summary.identifier].filter(Boolean).join(" "),
    };
  }
  return {
    icon: attachmentFileIcon,
    title: summary.title ?? t("message.attachments.textAttachment"),
    subtitle:
      summary.contextKind === "chat_history"
        ? "Previous conversation"
        : t("message.attachments.text"),
  };
}

function getChangeRequestSummarySubtitle(summary: UserMessageAttachmentSummary): string {
  if (summary.type === "github_pr") return `PR #${summary.number ?? ""}`;
  const presentation = getForgePresentation(summary.forge ?? "github");
  return `${presentation.changeRequestAbbrev} ${presentation.numberPrefix}${summary.number ?? ""}`;
}

/** Content for an attachment the daemon recorded on the timeline, where only its summary survives. */
export function getAttachmentSummaryPillContent(
  summary: UserMessageAttachmentSummary,
  t: TFunction,
): AttachmentPillContent {
  switch (summary.type) {
    case "image":
      return getImageSummaryPillContent(summary, t);
    case "text":
      return getTextSummaryPillContent(summary, t);
    case "review":
      return {
        icon: attachmentReviewIcon,
        title: t("message.attachments.review"),
        subtitle: getReviewSubtitle(summary.commentCount ?? 0, t),
      };
    case "forge_change_request":
    case "github_pr":
      return {
        icon: attachmentGithubPrIcon,
        title: summary.title ?? "",
        subtitle: getChangeRequestSummarySubtitle(summary),
      };
    case "forge_issue":
    case "github_issue":
      return {
        icon: attachmentGithubIssueIcon,
        title: summary.title ?? "",
        subtitle: `Issue #${summary.number ?? ""}`,
      };
    default: {
      const fileName = summary.fileName ?? summary.title ?? t("message.attachments.file");
      return {
        icon: attachmentFileIcon,
        title: fileName,
        subtitle: getFileTypeLabel(fileName) ?? t("message.attachments.file"),
      };
    }
  }
}

export function getWorkspaceAttachmentPillContent(
  attachment: WorkspaceComposerAttachment,
  t: TFunction,
): AttachmentPillContent {
  if (attachment.kind === "browser_element") {
    return {
      icon: attachmentBrowserIcon,
      title: attachment.attachment.tag,
      subtitle: t("composer.attachments.element"),
    };
  }
  if (isPullRequestContextAttachment(attachment)) {
    return {
      icon: attachmentFileIcon,
      title: attachment.title,
      subtitle: getPullRequestContextSubtitle(attachment),
    };
  }
  if (attachment.kind === "chat_history") {
    return {
      icon: attachmentFileIcon,
      title: attachment.attachment.title ?? t("message.attachments.textAttachment"),
      subtitle: getTextAttachmentSubtitle(attachment.attachment, t),
    };
  }
  return {
    icon: attachmentReviewIcon,
    title: t("message.attachments.review"),
    subtitle: getReviewSubtitle(attachment.commentCount, t),
  };
}

const ThemedAttachmentFileText = withUnistyles(FileText);
const ThemedAttachmentGitPullRequest = withUnistyles(GitPullRequest);
const ThemedAttachmentCircleDot = withUnistyles(CircleDot);
const ThemedAttachmentMessageSquareCode = withUnistyles(MessageSquareCode);
const ThemedAttachmentMousePointer = withUnistyles(MousePointer2);
const ThemedAttachmentImage = withUnistyles(ImageIcon);

const iconForegroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const attachmentReviewIcon = (
  <ThemedAttachmentMessageSquareCode size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
);
const attachmentGithubPrIcon = (
  <ThemedAttachmentGitPullRequest size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
);
const attachmentGithubIssueIcon = (
  <ThemedAttachmentCircleDot size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
);
const attachmentFileIcon = (
  <ThemedAttachmentFileText size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
);
const attachmentBrowserIcon = (
  <ThemedAttachmentMousePointer size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
);
const attachmentImageIcon = (
  <ThemedAttachmentImage size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
);
