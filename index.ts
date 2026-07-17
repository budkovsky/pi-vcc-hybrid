import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scaffoldSettings } from "./src/core/settings";
import { registerBeforeCompactHook } from "./src/hooks/before-compact";
import { registerProactiveThresholdHook } from "./src/hooks/proactive-threshold";
import { registerPiVccCommand } from "./src/commands/pi-vcc";
import { registerVccRecallCommand } from "./src/commands/vcc-recall";
import { registerRecallTool } from "./src/tools/recall";
import { registerInvisibleContinue } from "./src/core/invisible-continue";

export default (pi: ExtensionAPI) => {
  scaffoldSettings();
  registerInvisibleContinue(pi);
  registerBeforeCompactHook(pi);
  registerProactiveThresholdHook(pi);
  registerPiVccCommand(pi);
  registerVccRecallCommand(pi);
  registerRecallTool(pi);
};
