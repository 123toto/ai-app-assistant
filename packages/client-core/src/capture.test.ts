// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { capturePage } from "./capture.js";

describe("capturePage", () => {
  it("captures the whole document and an ordinary selected element", () => {
    document.head.innerHTML = '<meta name="description" content="Test application">';
    document.body.innerHTML = `
      <main>
        <h1>Commande</h1>
        <label for="secret">Référence</label>
        <input id="secret" value="PERSONAL-DATA">
        <button disabled>Valider</button>
      </main>
    `;
    const button = document.querySelector("button");
    if (!button) throw new Error("Missing fixture button");

    const result = capturePage({ selectedElement: button });

    expect(result.html).toContain("<!doctype html>");
    expect(result.html).toContain("Test application");
    expect(JSON.stringify(result)).not.toContain("PERSONAL-DATA");
    expect(result.selectedElementHtml).toContain("<button");
    expect(result.selectedElementHtml).toContain("Valider");
  });

  it("removes configured sensitive subtrees", () => {
    document.body.innerHTML = `
      <main><h1>Dashboard</h1><section data-sensitive>Private account</section></main>
    `;

    const result = capturePage();

    expect(result.html).toContain("Dashboard");
    expect(result.html).not.toContain("Private account");
    expect(result.htmlTruncated).toBe(false);
  });

  it("includes live form values only after explicit opt-in", () => {
    document.body.innerHTML = '<input value="initial">';
    const input = document.querySelector("input") as HTMLInputElement;
    input.value = "live value";

    const result = capturePage({ includeFormValues: true });

    expect(result.html).toContain("live value");
  });

  it("reports explicit HTML truncation", () => {
    document.body.innerHTML = `<main>${"content".repeat(100)}</main>`;

    const result = capturePage({ maxHtmlChars: 100 });

    expect(result.html).toHaveLength(100);
    expect(result.htmlTruncated).toBe(true);
  });

  it("drops styling and framework bookkeeping without dropping visible content", () => {
    document.head.innerHTML = '<style>.large{color:red}</style><script>ignored()</script>';
    document.body.innerHTML = '<main _ngcontent-test style="color:red"><svg><path d="M0 0"/><text>92%</text></svg><p>Visible metric</p></main>';

    const result = capturePage();

    expect(result.html).toContain('Visible metric');
    expect(result.html).toContain('92%');
    expect(result.html).not.toContain('<style');
    expect(result.html).not.toContain('<script');
    expect(result.html).not.toContain('_ngcontent');
    expect(result.html).not.toContain('<path');
  });
});
