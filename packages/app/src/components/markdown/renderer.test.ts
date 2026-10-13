/**
 * @vitest-environment jsdom
 */
import * as React from "react";
import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { Text, type StyleProp, type TextStyle } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveInlineImageSize } from "./inline-image-size";
import { colorMarkdownLinkChildren } from "./link-children";
import { MarkdownLinkText } from "./link-text";
import { useMarkdownLinkPress } from "@/swarm/canonical-links";

vi.stubGlobal("React", React);
afterEach(cleanup);

vi.mock("react-native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-native")>()),
  Pressable: ({
    accessibilityRole,
    children,
    onHoverIn,
    onHoverOut,
    onPress,
  }: {
    accessibilityRole?: string;
    children?: ReactNode;
    onHoverIn?(): void;
    onHoverOut?(): void;
    onPress?(): void;
  }) =>
    createElement(
      "div",
      {
        role: accessibilityRole,
        onClick: onPress,
        onMouseEnter: onHoverIn,
        onMouseLeave: onHoverOut,
      },
      children,
    ),
  Text: ({ children, style }: { children?: ReactNode; style?: StyleProp<TextStyle> }) =>
    createElement("span", { style: flattenStyle(style) }, children),
}));

function flattenStyle(style: StyleProp<TextStyle>): TextStyle {
  return Object.assign({}, ...(Array.isArray(style) ? style.filter(Boolean) : [style]));
}

function useLatestCaller({ consume }: { consume: boolean }) {
  return useMarkdownLinkPress(() => !consume);
}

describe("resolveInlineImageSize", () => {
  it("respects a one-sided explicit width using natural aspect ratio", () => {
    expect(
      resolveInlineImageSize({ explicit: { width: 18 }, natural: { width: 90, height: 45 } }),
    ).toEqual({
      width: 18,
      height: 9,
    });
  });

  it("respects a one-sided explicit height using natural aspect ratio", () => {
    expect(
      resolveInlineImageSize({ explicit: { height: 18 }, natural: { width: 90, height: 45 } }),
    ).toEqual({
      width: 36,
      height: 18,
    });
  });

  it("reserves a capped 3:2 placeholder when no dimensions are known", () => {
    expect(resolveInlineImageSize({ explicit: {}, natural: null })).toEqual({
      width: 240,
      height: 160,
    });
  });
});

describe("shared Markdown links", () => {
  it("lets an existing Task callback consume the actual link press first", () => {
    const uri = "paseo-swarm://task/task-ID";
    const caller = vi.fn(() => false);
    const { result } = renderHook(() => useMarkdownLinkPress(caller));
    const handled = vi.fn();
    const onPress = () => handled(result.current(uri));
    const view = render(createElement(MarkdownLinkText, { style: {}, onPress }, "Task"));
    fireEvent.click(view.getByRole("link"));
    expect(caller).toHaveBeenCalledExactlyOnceWith(uri);
    expect(handled).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("leaves hostless canonical links and HTTP links to the existing default", () => {
    const { result } = renderHook(() => useMarkdownLinkPress());
    expect(result.current("paseo-swarm://agent/planner.worker")).toBe(true);
    expect(result.current("https://paseo.sh")).toBe(true);
  });

  it("uses the latest caller without replacing the retained handler", () => {
    const { result, rerender } = renderHook(useLatestCaller, {
      initialProps: { consume: true },
    });
    const first = result.current;
    expect(first("paseo-swarm://task/task-ID")).toBe(false);
    rerender({ consume: false });
    expect(result.current).toBe(first);
    expect(first("paseo-swarm://task/task-ID")).toBe(true);
  });

  it("renders accent text and underlines it while hovered", () => {
    const onPress = vi.fn();
    const children = colorMarkdownLinkChildren(
      createElement(Text, { style: { color: "white" } }, "Paseo"),
      "rgb(0, 122, 255)",
    );
    const view = render(
      createElement(MarkdownLinkText, { style: { color: "rgb(0, 122, 255)" }, onPress }, children),
    );
    const link = view.getByRole("link");
    const linkText = link.firstElementChild as HTMLElement;

    expect((view.getByText("Paseo") as HTMLElement).style.color).toBe("rgb(0, 122, 255)");
    expect(linkText.style.textDecorationLine).toBe("");

    fireEvent.mouseEnter(link);
    expect(linkText.style.textDecorationLine).toBe("underline");

    fireEvent.mouseLeave(link);
    expect(linkText.style.textDecorationLine).toBe("");

    fireEvent.click(link);
    expect(onPress).toHaveBeenCalledOnce();
  });
});
