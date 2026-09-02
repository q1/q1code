import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";
import { decodeForkConfig, decodeForkConfigJson } from "./config.ts";

describe("fork config", () => {
  it("decodes a flags section", () => {
    const exit = decodeForkConfig({ flags: { "update-check": true } });
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ flags: { "update-check": true } });
  });

  it("accepts an empty object", () => {
    expect(Exit.isSuccess(decodeForkConfig({}))).toBe(true);
  });

  it("drops unknown sections and unknown flag keys", () => {
    const exit = decodeForkConfig({
      flags: { cliproxy: true, "not-a-flag": "whatever" },
      future: { anything: 1 },
    });
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ flags: { cliproxy: true } });
  });

  it("rejects non-boolean values for known flags", () => {
    expect(Exit.isFailure(decodeForkConfig({ flags: { cliproxy: "yes" } }))).toBe(true);
  });

  it("decodes raw JSON text and rejects malformed text", () => {
    const ok = decodeForkConfigJson('{"flags":{"cliproxy":true}}');
    expect(Exit.isSuccess(ok) && ok.value).toEqual({ flags: { cliproxy: true } });
    expect(Exit.isFailure(decodeForkConfigJson("{not json"))).toBe(true);
  });
});
