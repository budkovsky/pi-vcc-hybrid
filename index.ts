import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scaffoldSettings } from "./src/core/settings";
import { registerBeforeCompactHook } from "./src/hooks/before-compact";
import { registerProactiveThresholdHook } from "./src/hooks/proactive-threshold";
import { registerPiVccCommand } from "./src/commands/pi-vcc";
import { registerVccRecallCommand } from "./src/commands/vcc-recall";
import { registerRecallTool } from "./src/tools/recall";
import { registerInvisibleContinue } from "./src/core/invisible-continue";
import { loadSemanticConfig } from "./src/semantic/config";
import { QmdBackend } from "./src/semantic/qmd";
import { registerSemanticRecallTool } from "./src/semantic/recall-tool";

export default (pi: ExtensionAPI) => {
  scaffoldSettings();
  registerInvisibleContinue(pi);
  registerBeforeCompactHook(pi);
  registerProactiveThresholdHook(pi);
  registerPiVccCommand(pi);
  registerVccRecallCommand(pi);
  registerRecallTool(pi);

  // Semantic layer (Phase 4): semantic_recall tool. Not registered when
  // semantic.enabled=false; the backend is lazy (no I/O until first use).
  const semanticConfig = loadSemanticConfig();
  registerSemanticRecallTool(pi, {
    config: semanticConfig,
    backend: new QmdBackend({
      indexName: semanticConfig.indexName,
      daemonPort: semanticConfig.daemonPort,
      gpu: semanticConfig.gpu,
    }),
  });
};
