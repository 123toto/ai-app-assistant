import type { GeneratedAnswer } from "@123toto/ai-app-assistant-contracts";
import type { EvidenceBundle } from "./types.js";

export function evaluateConfidence(
  bundle: EvidenceBundle,
  answer: GeneratedAnswer,
  minimumEvidence: number
) {
  const evidence = answer.evidence ?? [];
  const limitations = answer.limitations ?? [];
  const availableReferences = new Set(bundle.items.map((item) => item.reference));
  const validCitations = new Set(evidence
    .filter((item) => availableReferences.has(item.reference))
    .map((item) => item.reference));
  const rankedEvidence = [...bundle.items]
    .sort((left, right) => right.relevance - left.relevance)
    .slice(0, 4);
  const averageRelevance = rankedEvidence.reduce(
    (total, item) => total + item.relevance,
    0
  ) / Math.max(rankedEvidence.length, 1);
  const expectedCitations = Math.min(bundle.items.length, 4);
  const citationCoverage = validCitations.size / Math.max(expectedCitations, 1);
  const sources = new Set(bundle.items.map((item) => item.source));
  const sourceDiversity = Math.min(sources.size / 3, 1);
  const hasSelectedElement = bundle.items.some((item) => item.source === "selected-element");
  const hasPageHtml = bundle.items.some((item) => item.source === "page-html");
  const hasDocumentation = bundle.items.some((item) => item.source === "document");

  let score = 0;
  if (bundle.items.length >= minimumEvidence) score += 0.1;
  score += averageRelevance * 0.35;
  score += citationCoverage * 0.3;
  score += sourceDiversity * 0.1;
  if (hasDocumentation) score += 0.1;
  if (hasPageHtml) score += 0.05;
  if (hasSelectedElement) score += 0.05;

  if (!hasPageHtml) score = Math.min(score, 0.7);
  if (!hasDocumentation) score = Math.min(score, 0.8);
  if (validCitations.size === 0) score = Math.min(score, 0.7);
  else if (citationCoverage < 0.5) score = Math.min(score, 0.8);
  // A response that declares a material limitation must not present itself as
  // highly reliable. This also drives the cautious tone used by the clients.
  if (limitations.length > 0) score = Math.min(score, 0.74);
  if (answer.answerability === "partial") score = Math.min(score, 0.49);
  if (answer.answerability === "not-answerable") score = Math.min(score, 0.2);

  const roundedScore = Math.min(0.95, round(score));
  const level =
    roundedScore >= 0.75 ? "high"
      : roundedScore >= 0.5 ? "medium"
        : roundedScore >= 0.25 ? "low"
          : "insufficient";

  const reasons = [
    `${bundle.items.length} preuve(s) pertinente(s) trouvée(s).`,
    `Pertinence moyenne des meilleures preuves : ${Math.round(averageRelevance * 100)} %.`,
    `${validCitations.size}/${expectedCitations} preuve(s) principale(s) citée(s).`
  ];
  if (hasDocumentation) {
    reasons.push("La réponse s’appuie sur la documentation fournie par l’application.");
  }
  if (hasPageHtml) reasons.push("La page HTML complète est disponible pour l’inférence.");
  if (hasSelectedElement) reasons.push("L’élément sélectionné précise la question.");
  if (limitations.length > 0) {
    reasons.push("Les limitations déclarées plafonnent le niveau de confiance.");
  }
  if (answer.answerability === "partial") {
    reasons.push("Une partie seulement de la question est étayée par les preuves.");
  }
  if (answer.answerability === "not-answerable") {
    reasons.push("Le fait exact demandé n’est pas disponible dans les preuves.");
  }

  return { level, score: roundedScore, reasons } as const;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
