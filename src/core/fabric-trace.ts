type FabricOperationOutcome = "succeeded" | "failed" | "aborted" | "timed_out";

export interface FabricOperation {
  ref: string;
  name: string;
  args: Record<string, unknown>;
  outcome: FabricOperationOutcome;
  error?: string;
  result?: unknown;
}

const OUTCOMES = new Set<FabricOperationOutcome>([
  "succeeded",
  "failed",
  "aborted",
  "timed_out",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const identityOf = (ref: string, provider?: unknown, action?: unknown) => {
  const separator = ref.indexOf(".");
  const lexicalProvider = separator > 0 ? ref.slice(0, separator) : undefined;
  const lexicalAction = separator > 0 && separator < ref.length - 1
    ? ref.slice(separator + 1)
    : undefined;
  const resolvedProvider = typeof provider === "string" ? provider : lexicalProvider;
  const resolvedAction = typeof action === "string" ? action : lexicalAction;
  return {
    name: resolvedProvider === "pi" && resolvedAction
      ? resolvedAction
      : resolvedAction ?? ref,
  };
};

const operationOf = (value: unknown): FabricOperation | undefined => {
  if (!isRecord(value) || typeof value.ref !== "string" || !isRecord(value.args)) {
    return undefined;
  }
  if (!OUTCOMES.has(value.outcome as FabricOperationOutcome)) return undefined;
  if (value.error !== undefined && typeof value.error !== "string") return undefined;
  return {
    ref: value.ref,
    name: identityOf(value.ref, value.provider, value.action).name,
    args: value.args,
    outcome: value.outcome as FabricOperationOutcome,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, "result") ? { result: value.result } : {}),
  };
};

const legacyOperationOf = (value: unknown): FabricOperation | undefined => {
  if (!isRecord(value) || typeof value.ref !== "string" || !isRecord(value.args)) {
    return undefined;
  }
  if (typeof value.success !== "boolean") return undefined;
  if (value.error !== undefined && typeof value.error !== "string") return undefined;
  return {
    ref: value.ref,
    name: identityOf(value.ref).name,
    args: value.args,
    outcome: value.success ? "succeeded" : "failed",
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, "result") ? { result: value.result } : {}),
  };
};

/** Read the durable nested-operation projection stored by pi-fabric on a fabric_exec result. */
export const fabricOperationsOf = (details: unknown): FabricOperation[] => {
  if (!isRecord(details)) return [];
  if (isRecord(details.trace)) {
    const trace = details.trace;
    if (trace.kind !== "pi-fabric.execution" || trace.version !== 1 || !Array.isArray(trace.operations)) {
      return [];
    }
    const operations: FabricOperation[] = [];
    for (const value of trace.operations) {
      const operation = operationOf(value);
      if (!operation) return [];
      operations.push(operation);
    }
    return operations;
  }
  if (!Array.isArray(details.audits)) return [];
  const operations: FabricOperation[] = [];
  for (const value of details.audits) {
    const operation = legacyOperationOf(value);
    if (!operation) return [];
    operations.push(operation);
  }
  return operations;
};

export const fabricArgsText = (operation: FabricOperation): string => {
  try {
    return JSON.stringify(operation.args);
  } catch {
    return Object.keys(operation.args).join(" ");
  }
};

export const fabricResultText = (operation: FabricOperation): string => {
  if (operation.error) return operation.error;
  const value = operation.result;
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    for (const key of ["output", "text", "content"]) {
      if (typeof value[key] === "string") return value[key] as string;
    }
  }
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
