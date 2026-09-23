import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { expandHomePath, resolveOutputDestination } from "../path-policy.js";
import { saveBase64Image } from "../file-utils.js";

let tmp: string; let root: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hokuz-path-"));
  root = path.join(tmp, "root"); await fs.mkdir(root);
  vi.stubEnv("HOKUZ_OUTPUT_ROOT", root);
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(tmp, { recursive: true, force: true }); });

describe("output root", () => {
  it("rejects a file used as an explicitly requested directory", async () => {
    await fs.writeFile(path.join(root, "notes.txt"), "keep this");
    await expect(resolveOutputDestination("notes.txt/"))
      .rejects.toMatchObject({ issue: { code: "FILE_WRITE_ERROR" } });
    expect(await fs.readFile(path.join(root, "notes.txt"), "utf8")).toBe("keep this");
  });

  it("saves relative paths under the root and rejects traversal and symlink escapes", async () => {
    const bytes = Buffer.from("tiny bytes").toString("base64");
    const saved = await saveBase64Image(bytes, "nested/photo.png", "png");
    expect(saved).toBe(path.join(await fs.realpath(root), "nested/photo.png"));
    expect(await fs.readFile(saved, "utf8")).toBe("tiny bytes");
    const outside = path.join(tmp, "outside"); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, "escape"), "dir");
    for (const target of ["../outside/bad.png", path.join(outside, "bad.png"), "escape/bad.png"]) {
      await expect(saveBase64Image(bytes, target, "png")).rejects.toMatchObject({ issue: { code: "FILE_WRITE_ERROR" } });
    }
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("rejects a dangling symlink and invalid root configuration", async () => {
    await fs.symlink(path.join(tmp, "missing"), path.join(root, "dangling"), "dir");
    await expect(resolveOutputDestination("dangling/new.png")).rejects.toMatchObject({ issue: { code: "FILE_WRITE_ERROR" } });
    vi.stubEnv("HOKUZ_OUTPUT_ROOT", "");
    await expect(resolveOutputDestination("photo.png")).rejects.toMatchObject({ issue: { code: "FILE_WRITE_ERROR" } });
    vi.stubEnv("HOKUZ_OUTPUT_ROOT", undefined);
    expect(await resolveOutputDestination("photo.png")).toBe(path.resolve("photo.png"));
  });
});

it("checks unrooted directory symlinks but leaves final filename collisions to the writer", async () => {
  vi.stubEnv("HOKUZ_OUTPUT_ROOT", undefined);
  const dangling = path.join(tmp, "dangling.jpg");
  const missing = path.join(tmp, "missing-target");
  await fs.symlink(missing, dangling);
  await expect(resolveOutputDestination(path.join(dangling, "image.jpg")))
    .rejects.toMatchObject({ issue: { code: "FILE_WRITE_ERROR" } });

  const saved = await saveBase64Image(Buffer.from("paid image").toString("base64"), dangling, "jpeg");
  expect(saved).toBe(path.join(tmp, "dangling-2.jpg"));
  expect(await fs.readFile(saved, "utf8")).toBe("paid image");
  expect(await fs.readlink(dangling)).toBe(missing);
  await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });

  const linked = path.join(tmp, "linked");
  await fs.symlink(root, linked, "dir");
  const nested = path.join(linked, "new", "nested", "image.jpg");
  expect(await resolveOutputDestination(nested)).toBe(nested);
  expect(await saveBase64Image(Buffer.from("nested image").toString("base64"), nested, "jpeg")).toBe(nested);
  expect(await fs.readFile(path.join(root, "new", "nested", "image.jpg"), "utf8")).toBe("nested image");
});

it("expands only the current home and uses the account home when HOME is unset", () => {
  vi.stubEnv("HOME", root);
  expect(expandHomePath("~/photo.png")).toBe(`${root}/photo.png`);
  expect(expandHomePath("~")).toBe(root);
  expect(expandHomePath("~otheruser/photo.png")).toBe("~otheruser/photo.png");
  vi.stubEnv("HOME", undefined);
  expect(expandHomePath("~/photo.png")).toBe(`${os.homedir()}/photo.png`);
});
