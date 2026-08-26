import { createServer } from "node:http";
import {
  createAiDocsNodeHttpListener,
  createAiDocsConfigurationRepository,
  createManagedAiDocsServer,
  createMemoryAiDocsStore,
  type AnswerGenerator,
  type EvidenceBundle,
  type GeneratedAnswer
} from "@123toto/ai-app-assistant-server";

const fakeGenerator: AnswerGenerator = {
  modelId: "fake:deterministic",
  async generate(bundle: EvidenceBundle): Promise<GeneratedAnswer> {
    const evidence = bundle.items[0];
    return {
      answer: {
        title: "Aide contextuelle",
        summary: evidence
          ? `Cette explication repose sur : ${evidence.content}`
          : "Aucune explication disponible.",
        sections: []
      },
      evidence: evidence
        ? [{
            source: evidence.source,
            reference: evidence.reference,
            excerpt: evidence.content
          }]
        : [],
      limitations: ["Le serveur de démonstration utilise un générateur factice."]
    };
  }
};

const aiDocs = createManagedAiDocsServer({
  configuration: {
    repository: createAiDocsConfigurationRepository({
      store: createMemoryAiDocsStore(),
      secretProtector: { protect: String, unprotect: String }
    }),
    defaultConfiguration: {
      provider: "ollama",
      model: "demo",
      access: { mode: "all" }
    },
    testConnection: async () => ({ success: true, model: "ollama:demo", latencyMs: 1 })
  },
  runtime: { createGenerator: () => fakeGenerator },
  http: {
    allowAnonymous: true,
    authorizeAdministration: () => undefined
  }
});

await aiDocs.setDocuments([
    {
      id: "application-guide",
      title: "Guide de l’application",
      mediaType: "text/markdown",
      content: "Cette application permet de consulter et valider des commandes."
    },
    {
      id: "openapi",
      title: "Documentation API",
      mediaType: "application/json",
      content: {
        openapi: "3.1.0",
        paths: {
          "/orders/{id}/validate": {
            post: {
              summary: "Valider une commande",
              description: "Valide une commande lorsque toutes ses lignes sont complètes."
            }
          }
        }
      }
    }
]);
await aiDocs.initialize();

createServer(createAiDocsNodeHttpListener(aiDocs.fetch)).listen(3000, () => {
  console.log("Demo API listening on http://localhost:3000");
});
