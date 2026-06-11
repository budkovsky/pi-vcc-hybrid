import { compile } from "./src/core/summarize";

const FILES = [
  "src/auth.ts", "src/users.ts", "src/api.ts", "src/db.ts",
  "src/utils.ts", "src/config.ts", "src/routes.ts", "src/middleware.ts",
  "src/models.ts", "src/services.ts", "src/handlers.ts", "src/types.ts",
  "src/errors.ts", "src/validators.ts", "src/cache.ts", "src/logger.ts",
  "src/session.ts", "src/token.ts", "src/oauth.ts", "src/crypto.ts",
];

const GOALS = [
  "Build an authentication system",
  "Add user management endpoints",
  "Create the REST API layer",
  "Set up the database connection pool",
  "Implement utility functions",
  "Load configuration from environment",
  "Define route handlers",
  "Add authentication middleware",
  "Create data models",
  "Build the service layer",
  "Implement request handlers",
  "Add TypeScript type definitions",
  "Create error handling utilities",
  "Build input validators",
  "Add caching layer",
  "Set up structured logging",
  "Implement session management",
  "Add JWT token handling",
  "Build OAuth2 integration",
  "Add cryptographic utilities",
  "Refactor auth to support SSO",
  "Add rate limiting to API",
  "Migrate database to PostgreSQL",
  "Add integration tests",
  "Set up CI pipeline",
];

const makeRound = (roundIdx: number): any[] => {
  const file1 = FILES[roundIdx % FILES.length];
  const file2 = FILES[(roundIdx + 7) % FILES.length];
  const goal = GOALS[roundIdx % GOALS.length];
  const id1 = `r${roundIdx}-1`;
  const id2 = `r${roundIdx}-2`;
  const id3 = `r${roundIdx}-3`;

  const msgs: any[] = [
    { role: "user", content: goal },
    { role: "assistant", content: [{ type: "toolCall", name: "Edit", id: id1, arguments: { file_path: file1, oldText: "// placeholder", newText: `export function fn${roundIdx}() { return ${roundIdx}; }` } }] },
    { role: "toolResult", toolCallId: id1, toolName: "Edit", content: "OK" },
    { role: "assistant", content: `Edited ${file1} with function fn${roundIdx}.` },
    { role: "assistant", content: [{ type: "toolCall", name: "read", id: id2, arguments: { file_path: file2 } }] },
    { role: "toolResult", toolCallId: id2, toolName: "read", content: `// ${file2}\nexport const DATA = ${roundIdx};` },
    { role: "assistant", content: `Read ${file2} to understand the interface.` },
  ];
  if (roundIdx % 3 === 0) {
    msgs.push(
      { role: "assistant", content: [{ type: "toolCall", name: "bash", id: id3, arguments: { command: `git commit -m "feat: ${goal.toLowerCase()}" ` } }] },
      { role: "toolResult", toolCallId: id3, toolName: "bash", content: `[main abc${String(roundIdx).padStart(4, "0")}] feat: ${goal.toLowerCase()}` },
      { role: "assistant", content: `Committed: feat: ${goal.toLowerCase()}.` },
    );
  }
  return msgs;
};

let prev = "";
const goalRecovery = new Map<string, {
  rounds: number[];
  recoveredByRound: boolean[];
  directMention: boolean[];
  breadcrumbOnly: boolean[];
  firstLostRound: number | null;
}>();

for (let round = 0; round < 100; round++) {
  const goal = GOALS[round % GOALS.length];
  const msgs = makeRound(round);
  const result = compile({ messages: msgs, previousSummary: prev || undefined });
  prev = result;

  if (!goalRecovery.has(goal)) {
    goalRecovery.set(goal, { rounds: [], recoveredByRound: [], directMention: [], breadcrumbOnly: [], firstLostRound: null });
  }
  const entry = goalRecovery.get(goal)!;
  entry.rounds.push(round + 1);

  const directInGoals = result.includes(goal);

  let breadcrumbHit = false;
  const keywords = goal.split(/\s+/).filter(w => w.length > 3).slice(0, 3);
  for (const line of result.split("\n")) {
    if (line.startsWith("- ...recall:")) {
      if (keywords.every(kw => line.toLowerCase().includes(kw.toLowerCase()))) breadcrumbHit = true;
    }
  }

  const recoverable = directInGoals || breadcrumbHit;
  entry.recoveredByRound.push(recoverable);
  entry.directMention.push(directInGoals);
  entry.breadcrumbOnly.push(breadcrumbHit && !directInGoals);

  if (!recoverable && entry.firstLostRound === null) {
    entry.firstLostRound = round + 1;
  }
}

console.log("=== GOAL RECOVERY ANALYSIS (100 compactions) ===\n");

const alwaysPresent: string[] = [];
const sometimesLost: any[] = [];
const alwaysLost: any[] = [];

for (const [goal, entry] of goalRecovery) {
  const total = entry.rounds.length;
  const recovered = entry.recoveredByRound.filter(Boolean).length;
  const directCount = entry.directMention.filter(Boolean).length;
  const breadcrumbOnlyCount = entry.breadcrumbOnly.filter(Boolean).length;
  const rate = recovered / total;

  if (rate === 1) alwaysPresent.push(goal);
  else if (rate === 0) alwaysLost.push({ goal, total, directCount, breadcrumbOnlyCount, firstLost: entry.firstLostRound });
  else sometimesLost.push({ goal, total, recovered, rate, directCount, breadcrumbOnlyCount, firstLost: entry.firstLostRound });
}

console.log(`UNIQUE GOALS: ${goalRecovery.size}`);
console.log(`Always recoverable: ${alwaysPresent.length}`);
console.log(`Sometimes lost:     ${sometimesLost.length}`);
console.log(`Always lost:        ${alwaysLost.length}\n`);

if (alwaysPresent.length > 0) {
  console.log("--- ALWAYS RECOVERABLE ---");
  for (const g of alwaysPresent) console.log(`  ${g}`);
  console.log();
}

if (sometimesLost.length > 0) {
  console.log("--- SOMETIMES LOST ---");
  for (const g of sometimesLost) console.log(`  ${(g.rate * 100).toFixed(0).padStart(3)}% recovery | lost first at round ${g.firstLost} | ${g.directCount} direct, ${g.breadcrumbOnlyCount} bc-only | ${g.goal}`);
  console.log();
}

if (alwaysLost.length > 0) {
  console.log("--- ALWAYS LOST (0% recovery) ---");
  for (const g of alwaysLost) console.log(`  lost first at round ${g.firstLost} | direct:${g.directCount} bc:${g.breadcrumbOnlyCount} | ${g.goal}`);
  console.log();
}

// Show the actual sections at round 100
console.log("=== SESSION GOAL SECTION AT ROUND 100 ===");
const goalIdx = prev.indexOf("[Session Goal]");
const goalEnd = prev.indexOf("\n\n[", goalIdx + 1);
console.log(prev.slice(goalIdx, goalEnd > 0 ? goalEnd : prev.indexOf("\n\n---\n\n", goalIdx)));

console.log("\n=== EARLIER TURNS SECTION AT ROUND 100 ===");
const turnsIdx = prev.indexOf("[Earlier Turns]");
const turnsEnd = prev.indexOf("\n\n---\n\n", turnsIdx);
console.log(prev.slice(turnsIdx, turnsEnd > 0 ? turnsEnd : undefined));

console.log("\n=== FILES AND CHANGES AT ROUND 100 ===");
const filesIdx = prev.indexOf("[Files And Changes]");
const filesEnd = prev.indexOf("\n\n[", filesIdx + 1);
console.log(prev.slice(filesIdx, filesEnd > 0 ? filesEnd : prev.indexOf("\n\n---\n\n", filesIdx)));

// Breadcrumb collision analysis
console.log("\n=== BREADCRUMB COLLISION ANALYSIS ===");
const crumbs = new Map<string, string[]>();
for (const line of prev.split("\n")) {
  if (line.startsWith("- ...recall:")) {
    const content = line.slice("- ...recall: ".length);
    for (const part of content.split(", ")) {
      if (!crumbs.has(part)) crumbs.set(part, []);
      crumbs.get(part)!.push(content);
    }
  }
}
const collisions = [...crumbs.entries()].filter(([k, v]) => v.length > 1);
if (collisions.length > 0) {
  console.log(`Segments appearing in multiple breadcrumb lines (collisions):`);
  for (const [segment, lines] of collisions) {
    console.log(`  "${segment}" appears in ${lines.length} breadcrumb lines`);
  }
} else {
  console.log("No segment collisions detected.");
}

// What extractBreadcrumb produces for each goal
console.log("\n=== BREADCRUMB EXTRACTION FOR EACH GOAL ===");
const extractBreadcrumb = (line: string): string => {
  const text = line.replace(/^\s*-\s*/, "").trim();
  if (!text) return "";
  const fileMatch = text.match(/(?:edited |read |wrote |created |deleted )?(\S+\.\w{1,12})/);
  if (fileMatch) return fileMatch[1];
  const beforeArrow = text.split("\u2192")[0].trim();
  const words = beforeArrow.split(/\s+/).filter(w => w.length > 2).slice(0, 3);
  if (words.length > 0) return words.join(" ");
  const first = text.split(/\s+/).find(w => w.length > 2);
  return first ?? "";
};
for (const g of GOALS) {
  const bc = extractBreadcrumb(g);
  console.log(`  "${g}" -> "${bc}"`);
}
