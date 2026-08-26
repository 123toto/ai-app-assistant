// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { createElementPickerSession } from "./picker.js";

describe("createElementPickerSession", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("removes its overlay immediately when selection is cancelled", async () => {
    const session = createElementPickerSession();
    expect(document.querySelector(".ai-app-assistant-element-highlight")).not.toBeNull();

    session.cancel();

    await expect(session.result).rejects.toMatchObject({ name: "AbortError" });
    expect(document.querySelector(".ai-app-assistant-element-highlight")).toBeNull();
  });

  it("honours an already aborted external signal without leaving an overlay", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Stopped", "AbortError"));

    const session = createElementPickerSession({ signal: controller.signal });

    await expect(session.result).rejects.toMatchObject({ name: "AbortError" });
    expect(document.querySelector(".ai-app-assistant-element-highlight")).toBeNull();
  });
});
