// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElementPickerSession, pickElement } from "./picker.js";

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

  it("selects the hovered element and removes all picker UI", async () => {
    const button = document.createElement("button");
    button.textContent = "Choose me";
    document.body.append(button);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(button);

    const selected = pickElement({ overlayClassName: "test-picker-overlay" });
    document.dispatchEvent(new PointerEvent("pointermove", { clientX: 10, clientY: 10, bubbles: true }));
    await animationFrame();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await expect(selected).resolves.toBe(button);
    expect(document.querySelector(".test-picker-overlay")).toBeNull();
  });

  it("ignores elements inside excluded host UI", async () => {
    const excluded = document.createElement("aside");
    excluded.className = "host-ui";
    const button = document.createElement("button");
    excluded.append(button);
    document.body.append(excluded);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(button);
    const session = createElementPickerSession({ excludeSelectors: [".host-ui"] });

    document.dispatchEvent(new PointerEvent("pointermove", { clientX: 10, clientY: 10, bubbles: true }));
    await animationFrame();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    session.cancel();

    await expect(session.result).rejects.toMatchObject({ name: "AbortError" });
    expect(document.querySelector(".ai-app-assistant-element-highlight")).toBeNull();
  });
});

function animationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
