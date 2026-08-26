import { describe, expect, it } from "vitest";
import { evaluateConfidence } from "./confidence.js";
import type { EvidenceBundle } from "./types.js";

const bundle: EvidenceBundle = {
  question: "Comment utiliser cette page ?",
  locale: "fr",
  items: [
    {
      source: "document",
      reference: "document:orders-guide",
      content: "Une commande peut être approuvée après sa revue.",
      relevance: 0.88
    },
    {
      source: "page-html",
      reference: "page-html",
      content: "<main><h1>Commande</h1></main>",
      relevance: 0.98
    },
    {
      source: "selected-element",
      reference: "selected-element",
      content: "<button>Approuver</button>",
      relevance: 1
    }
  ]
};

describe("evaluateConfidence", () => {
  it("uses relevance, source diversity and citation coverage without returning 100%", () => {
    const confidence = evaluateConfidence(bundle, {
      answer: { summary: "Résumé", sections: [] },
      evidence: bundle.items.map(({ source, reference }) => ({ source, reference })),
      limitations: []
    }, 1);

    expect(confidence.level).toBe("high");
    expect(confidence.score).toBeLessThan(1);
    expect(confidence.score).toBeGreaterThanOrEqual(0.75);
  });

  it("reduces confidence when the answer does not cite its evidence", () => {
    const confidence = evaluateConfidence(bundle, {
      answer: { summary: "Résumé", sections: [] },
      evidence: [],
      limitations: []
    }, 1);

    expect(confidence.score).toBeLessThan(0.75);
  });

  it("does not report high confidence when the answer declares limitations", () => {
    const confidence = evaluateConfidence(bundle, {
      answer: { summary: "Résumé", sections: [] },
      evidence: bundle.items.map(({ source, reference }) => ({ source, reference })),
      limitations: ["Le workflow exact n’est pas documenté."]
    }, 1);

    expect(confidence.level).toBe("medium");
    expect(confidence.score).toBe(0.74);
  });

  it("reports insufficient confidence when the exact question is not answerable", () => {
    const confidence = evaluateConfidence(bundle, {
      answerability: "not-answerable",
      answer: { summary: "Cette information n’est pas disponible.", sections: [] },
      evidence: bundle.items.map(({ source, reference }) => ({ source, reference })),
      limitations: ["L’identité demandée n’est pas présente dans la page."]
    }, 1);

    expect(confidence.level).toBe("insufficient");
    expect(confidence.score).toBe(0.2);
    expect(confidence.reasons).toContain("Le fait exact demandé n’est pas disponible dans les preuves.");
  });

  it("reports low confidence for a partially answered question", () => {
    const confidence = evaluateConfidence(bundle, {
      answerability: "partial",
      answer: { summary: "Une partie seulement est connue.", sections: [] },
      evidence: bundle.items.map(({ source, reference }) => ({ source, reference })),
      limitations: []
    }, 1);

    expect(confidence.level).toBe("low");
    expect(confidence.score).toBe(0.49);
  });
});
