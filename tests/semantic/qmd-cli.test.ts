import { describe, it, expect } from "bun:test";
import {
  EMBED_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  QmdError,
  collectionAddArgs,
  collectionRemoveArgs,
  daemonSpawnArgs,
  daemonStopArgs,
  embedArgs,
  qmdEnv,
} from "../../src/semantic/qmd-cli";

describe("qmd-cli: argv builders (Phase-0 contract, exact arrays)", () => {
  it("collection add: --index global flag first, --name for the collection", () => {
    expect(collectionAddArgs("pi-semantic", "/home/u/.pi/vector/s1", "s1")).toEqual([
      "--index",
      "pi-semantic",
      "collection",
      "add",
      "/home/u/.pi/vector/s1",
      "--name",
      "s1",
    ]);
  });

  it("collection remove: positional collection name", () => {
    expect(collectionRemoveArgs("pi-semantic", "s1")).toEqual([
      "--index",
      "pi-semantic",
      "collection",
      "remove",
      "s1",
    ]);
  });

  it("embed: scoped to the session collection with -c", () => {
    expect(embedArgs("pi-semantic", "s1")).toEqual([
      "--index",
      "pi-semantic",
      "embed",
      "-c",
      "s1",
    ]);
  });

  it("daemon spawn: --http --daemon with explicit port", () => {
    expect(daemonSpawnArgs("pi-semantic", 8390)).toEqual([
      "--index",
      "pi-semantic",
      "mcp",
      "--http",
      "--daemon",
      "--port",
      "8390",
    ]);
  });

  it("daemon stop: --index is required (bare stop hits the default index)", () => {
    expect(daemonStopArgs("pi-semantic")).toEqual(["mcp", "stop", "--index", "pi-semantic"]);
  });
});

describe("qmd-cli: env", () => {
  it("gpu=cpu → QMD_FORCE_CPU=1 (the contract default)", () => {
    expect(qmdEnv("cpu")).toEqual({ QMD_FORCE_CPU: "1" });
  });

  it("gpu=auto → QMD_FORCE_CPU=1 (auto means 'do not opt into GPU')", () => {
    expect(qmdEnv("auto")).toEqual({ QMD_FORCE_CPU: "1" });
  });

  it("gpu=force → no QMD_FORCE_CPU", () => {
    expect(qmdEnv("force")).toEqual({});
  });

  it("preserves unrelated base env entries", () => {
    expect(qmdEnv("cpu", { PATH: "/bin" })).toEqual({ QMD_FORCE_CPU: "1", PATH: "/bin" });
  });
});

describe("qmd-cli: timeouts", () => {
  it("pins the default command timeout", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  });

  it("pins a much longer embed timeout (≈0.2s/chunk CPU; 3000 chunks ≈ 10min)", () => {
    expect(EMBED_TIMEOUT_MS).toBe(600_000);
  });
});

describe("QmdError", () => {
  it("is an Error with a stable code", () => {
    const e = new QmdError("cli-failed", "boom");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("cli-failed");
    expect(e.message).toContain("boom");
  });
});
