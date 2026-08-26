/** Options for one complete, side-effect-free DOM capture. */
export interface CaptureOptions {
  /** Document by default; an element can deliberately restrict the captured subtree. */
  root?: Document | Element;
  /** Optional element explicitly picked by the user. */
  selectedElement?: Element;
  /** Optional hard limit. No truncation is performed when omitted. */
  maxHtmlChars?: number;
  /** Form values are removed by default because they may contain personal data. */
  includeFormValues?: boolean;
  /** Entire matching subtrees are removed from both page and selected HTML. */
  redactSelectors?: string[];
}

export interface CaptureResult {
  html: string;
  htmlTruncated: boolean;
  selectedElementHtml?: string;
}

/**
 * Serializes the rendered page and, optionally, the exact element selected by
 * the user. It does not derive identifiers or require application attributes.
 */
export function capturePage(options: CaptureOptions = {}): CaptureResult {
  const root = options.root ?? document;
  const redactSelectors = options.redactSelectors ?? ["[data-sensitive]"];
  const includeFormValues = options.includeFormValues ?? false;
  const serialized = serializeRoot(root, includeFormValues, redactSelectors);
  const maxHtmlChars = options.maxHtmlChars;
  const htmlTruncated = maxHtmlChars !== undefined && serialized.length > maxHtmlChars;
  const html = htmlTruncated ? serialized.slice(0, maxHtmlChars) : serialized;
  const selectedElementHtml = options.selectedElement
    && !matchesAny(options.selectedElement, redactSelectors)
    ? serializeElement(options.selectedElement, includeFormValues, redactSelectors)
    : undefined;

  return {
    html,
    htmlTruncated,
    ...(selectedElementHtml ? { selectedElementHtml } : {})
  };
}

function serializeRoot(
  root: Document | Element,
  includeFormValues: boolean,
  redactSelectors: string[]
): string {
  if (root.nodeType === 9) {
    const html = serializeElement(
      (root as Document).documentElement,
      includeFormValues,
      redactSelectors
    );
    return `<!doctype html>\n${html}`;
  }
  return serializeElement(root as Element, includeFormValues, redactSelectors);
}

function serializeElement(
  element: Element,
  includeFormValues: boolean,
  redactSelectors: string[]
): string {
  const clone = element.cloneNode(true) as Element;
  compactNonSemanticMarkup(clone);
  for (const selector of redactSelectors) {
    if (element.matches(selector)) return "<div data-redacted=\"true\"></div>";
    clone.querySelectorAll(selector).forEach((matched) => matched.remove());
  }
  if (includeFormValues) copyFormValues(element, clone);
  else redactFormValues(clone);
  return clone.outerHTML;
}

/**
 * Keeps the complete rendered content while dropping assets and framework
 * bookkeeping that add tokens but cannot help explain the page.
 */
function compactNonSemanticMarkup(root: Element): void {
  root.querySelectorAll("script, style, noscript, template, link[rel='stylesheet'], svg path, svg defs")
    .forEach(element => element.remove());
  const elements = [root, ...root.querySelectorAll("*")];
  for (const element of elements) {
    for (const attribute of [...element.attributes]) {
      if (
        attribute.name === "style"
        || attribute.name === "srcset"
        || attribute.name === "integrity"
        || attribute.name === "nonce"
        || attribute.name.startsWith("_ng")
        || attribute.name.startsWith("ng-reflect-")
      ) element.removeAttribute(attribute.name);
    }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const comments: Comment[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode as Comment);
  comments.forEach(comment => comment.remove());
}

function redactFormValues(root: Element): void {
  const fields = [
    ...(root.matches("input, textarea") ? [root] : []),
    ...root.querySelectorAll("input, textarea")
  ];
  for (const field of fields) {
    field.removeAttribute("value");
    field.removeAttribute("checked");
    if (field.tagName === "TEXTAREA") field.textContent = "";
  }
  root.querySelectorAll("option").forEach((option) => option.removeAttribute("selected"));
  const editable = [
    ...(root.matches("[contenteditable]") ? [root] : []),
    ...root.querySelectorAll("[contenteditable]")
  ];
  for (const element of editable) element.textContent = "";
}

function copyFormValues(source: Element, clone: Element): void {
  const sourceFields = [
    ...(source.matches("input, textarea, option") ? [source] : []),
    ...source.querySelectorAll("input, textarea, option")
  ];
  const cloneFields = [
    ...(clone.matches("input, textarea, option") ? [clone] : []),
    ...clone.querySelectorAll("input, textarea, option")
  ];

  sourceFields.forEach((field, index) => {
    const target = cloneFields[index];
    if (!target) return;
    if (field.tagName === "INPUT") {
      const input = field as HTMLInputElement;
      target.setAttribute("value", input.value);
      if (input.checked) target.setAttribute("checked", "");
      else target.removeAttribute("checked");
    } else if (field.tagName === "TEXTAREA") {
      target.textContent = (field as HTMLTextAreaElement).value;
    } else if (field.tagName === "OPTION") {
      if ((field as HTMLOptionElement).selected) target.setAttribute("selected", "");
      else target.removeAttribute("selected");
    }
  });
}

function matchesAny(element: Element, selectors: string[]): boolean {
  return selectors.some((selector) =>
    element.matches(selector) || element.closest(selector) !== null
  );
}
