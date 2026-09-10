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
import { registerSemanticLifecycle } from "./src/semantic/lifecycle";

export default (pi: ExtensionAPI) => {
  scaffoldSettings();
  registerInvisibleContinue(pi);

  // Semantic layer (Phase 4/6): one shared backend for the recall tool,
  // the compaction-hook indexer, and the lifecycle. Not active when
  // semantic.enabled=false (each registration self-gates); the backend is
  // lazy (no I/O until first use).
  const semanticConfig = loadSemanticConfig();
  const semanticBackend = new QmdBackend({
    indexName: semanticConfig.indexName,
    daemonPort: semanticConfig.daemonPort,
    gpu: semanticConfig.gpu,
  });

  registerBeforeCompactHook(pi, {
    semantic: { config: semanticConfig, backend: semanticBackend },
  });
  registerProactiveThresholdHook(pi);
  registerPiVccCommand(pi);
  registerVccRecallCommand(pi);
  registerRecallTool(pi);
  registerSemanticRecallTool(pi, { config: semanticConfig, backend: semanticBackend });
  registerSemanticLifecycle(pi, { config: semanticConfig, backend: semanticBackend });
};
