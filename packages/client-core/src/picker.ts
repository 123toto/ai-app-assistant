export interface ElementPickerOptions {
  signal?: AbortSignal;
  overlayClassName?: string;
  /** Selectors ignored by the picker, such as the assistant itself. */
  excludeSelectors?: string[];
}

export interface ElementPickerSession {
  result: Promise<Element>;
  cancel(reason?: unknown): void;
}

/** Starts a cancellable picker session whose listeners are always cleaned up. */
export function createElementPickerSession(
  options: ElementPickerOptions = {}
): ElementPickerSession {
  const controller = new AbortController();
  const relayAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) relayAbort();
  else options.signal?.addEventListener("abort", relayAbort, { once: true });

  const result = new Promise<Element>((resolve, reject) => {
    const overlay = document.createElement("div");
    overlay.className = options.overlayClassName ?? "ai-docs-element-highlight";
    Object.assign(overlay.style, {
      position: "fixed",
      pointerEvents: "none",
      zIndex: "2147483647",
      border: "2px solid #20a779",
      borderRadius: "8px",
      background: "rgba(32, 167, 121, 0.13)",
      boxShadow: "0 0 0 4px rgba(32, 167, 121, 0.12), 0 0 28px rgba(32, 167, 121, 0.38)",
      transition: "left 90ms ease, top 90ms ease, width 90ms ease, height 90ms ease",
      display: "none"
    });
    const glow = typeof overlay.animate === "function" ? overlay.animate([
      { boxShadow: "0 0 0 3px rgba(32,167,121,.12), 0 0 16px rgba(32,167,121,.28)" },
      { boxShadow: "0 0 0 7px rgba(32,167,121,.05), 0 0 34px rgba(32,167,121,.5)" },
      { boxShadow: "0 0 0 3px rgba(32,167,121,.12), 0 0 16px rgba(32,167,121,.28)" }
    ], { duration: 1_700, iterations: Infinity, easing: "ease-in-out" }) : undefined;
    document.body.append(overlay);

    let hovered: Element | undefined;
    let animationFrame: number | undefined;
    let pointer: { x: number; y: number } | undefined;
    let settled = false;

    const cleanup = () => {
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      controller.signal.removeEventListener("abort", onAbort);
      options.signal?.removeEventListener("abort", relayAbort);
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
      glow?.cancel();
      overlay.remove();
    };

    const finish = (element: Element) => {
      if (settled) return;
      settled = true;
      if (typeof overlay.animate !== "function") {
        cleanup();
        resolve(element);
        return;
      }
      const confirmation = overlay.animate([
        { opacity: 1, transform: "scale(1)" },
        { opacity: 1, transform: "scale(1.025)", background: "rgba(32,167,121,.3)" },
        { opacity: 0, transform: "scale(.96)" }
      ], { duration: 360, easing: "cubic-bezier(.2,.9,.3,1)" });
      void confirmation.finished.finally(() => {
        cleanup();
        resolve(element);
      });
    };

    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(reason);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (settled) return;
      pointer = { x: event.clientX, y: event.clientY };
      if (animationFrame !== undefined) return;
      animationFrame = requestAnimationFrame(() => {
        animationFrame = undefined;
        if (!pointer) return;
        const target = document.elementFromPoint(pointer.x, pointer.y);
        if (!target || target === overlay || isExcluded(target, options.excludeSelectors)) {
          hovered = undefined;
          overlay.style.display = "none";
          return;
        }
        hovered = target;
        const rect = target.getBoundingClientRect();
        Object.assign(overlay.style, {
          display: "block",
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`
        });
      });
    };

    const onClick = (event: MouseEvent) => {
      if (settled) return;
      const clicked = event.target;
      if (clicked instanceof Element && isExcluded(clicked, options.excludeSelectors)) return;
      if (!hovered) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(hovered);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      fail(new DOMException("Element selection cancelled.", "AbortError"));
    };

    const onAbort = () => {
      fail(controller.signal.reason ?? new DOMException("Aborted", "AbortError"));
    };

    if (controller.signal.aborted) {
      onAbort();
      return;
    }

    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });

  return {
    result,
    cancel: (reason = new DOMException("Element selection cancelled.", "AbortError")) => {
      controller.abort(reason);
    }
  };
}

export function pickElement(options: ElementPickerOptions = {}): Promise<Element> {
  return createElementPickerSession(options).result;
}

function isExcluded(element: Element, selectors: string[] | undefined): boolean {
  return (selectors ?? []).some((selector) =>
    element.matches(selector) || element.closest(selector) !== null
  );
}
