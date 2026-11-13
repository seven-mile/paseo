import { describe, expect, it } from "vitest";
import { splitHostPath } from "./kept-image";

describe("splitHostPath", () => {
  it("splits POSIX and Windows paths into a directory and a file name", () => {
    expect(splitHostPath("/home/me/.paseo/prompt-images/a1/abc.png")).toEqual({
      directory: "/home/me/.paseo/prompt-images/a1",
      name: "abc.png",
    });
    expect(splitHostPath("C:\\Users\\me\\.paseo\\prompt-images\\a1\\abc.png")).toEqual({
      directory: "C:\\Users\\me\\.paseo\\prompt-images\\a1",
      name: "abc.png",
    });
  });

  it("rejects paths without both parts", () => {
    expect(splitHostPath("abc.png")).toBeNull();
    expect(splitHostPath("/abc.png")).toBeNull();
    expect(splitHostPath("/home/me/")).toBeNull();
  });
});
