// Idempotent sync of backlog.mjs into GitHub (labels, milestones, issues) via the gh CLI REST API.
// Usage: node sync.mjs [--dry]
import { execFileSync } from "node:child_process";
import { issues, labels, milestones } from "./backlog.mjs";

const REPO = "repos/enzodheilly/near-sentinel";
const DRY = process.argv.includes("--dry");

function gh(args, input) {
  const out = execFileSync("gh", ["api", ...args], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  return out ? JSON.parse(out) : null;
}
function ghJson(method, path, body) {
  if (DRY) { console.log(`DRY ${method} ${path}`); return { number: 0, title: body?.title }; }
  return gh(["-X", method, path, "--input", "-"], JSON.stringify(body));
}
function listAll(path) {
  return gh(["--paginate", "--slurp", path]).flat();
}

// --- sanity checks on the spec itself ---
const titles = new Set();
for (const i of issues) {
  if (titles.has(i.title)) throw new Error(`duplicate title ${i.title}`);
  titles.add(i.title);
  if (!milestones.some((m) => m.title === i.sprint)) throw new Error(`unknown sprint for ${i.title}`);
  for (const l of i.labels) if (!labels.some((x) => x.name === l)) throw new Error(`unknown label ${l} in ${i.title}`);
}
for (const i of issues) for (const d of [...(i.depends ?? []), ...(i.blocks ?? [])]) if (!titles.has(d)) throw new Error(`${i.title} references unknown ${d}`);

// --- labels ---
const existingLabels = new Set(listAll(`${REPO}/labels?per_page=100`).map((l) => l.name));
for (const l of labels) {
  if (existingLabels.has(l.name)) continue;
  ghJson("POST", `${REPO}/labels`, l);
  console.log(`label  + ${l.name}`);
}

// --- milestones ---
const msByTitle = new Map(listAll(`${REPO}/milestones?state=all&per_page=100`).map((m) => [m.title, m]));
for (const m of milestones) {
  const existing = msByTitle.get(m.title);
  if (existing) {
    if (existing.description !== m.description) {
      ghJson("PATCH", `${REPO}/milestones/${existing.number}`, { description: m.description });
      console.log(`sprint ~ ${m.title}`);
    }
    continue;
  }
  const created = ghJson("POST", `${REPO}/milestones`, { title: m.title, description: m.description, due_on: `${m.due}T22:59:00Z` });
  msByTitle.set(m.title, created);
  console.log(`sprint + ${m.title}`);
}

// --- issues: pass 1 create (bodies need numbers of dependencies, so links are filled in pass 2) ---
const byTitle = new Map(listAll(`${REPO}/issues?state=all&per_page=100`).filter((i) => !i.pull_request).map((i) => [i.title, i]));
for (const i of issues) {
  if (byTitle.has(i.title)) continue;
  const created = ghJson("POST", `${REPO}/issues`, { title: i.title, labels: i.labels, milestone: msByTitle.get(i.sprint)?.number, body: "_(body pending)_" });
  byTitle.set(i.title, created);
  console.log(`issue  + #${created.number} ${i.title}`);
}

// --- pass 2: bodies with cross-links, then close shipped ones ---
const ref = (t) => `#${byTitle.get(t).number} ${t}`;
const blockedBy = new Map();
for (const i of issues) for (const b of i.blocks ?? []) blockedBy.set(b, [...(blockedBy.get(b) ?? []), i.title]);

for (const i of issues) {
  const deps = [...(i.depends ?? []), ...(blockedBy.get(i.title) ?? [])];
  const unblocks = [...(i.blocks ?? []), ...issues.filter((x) => (x.depends ?? []).includes(i.title)).map((x) => x.title)];
  const body = [
    i.goal,
    i.refs?.length ? `\n**Spec:** ${i.refs.map((r) => `\`${r}\``).join(", ")}` : "",
    i.files?.length ? `\n**Files:**\n${i.files.map((f) => `- \`${f}\``).join("\n")}` : "",
    `\n**Definition of done:**\n${i.criteria.map((c) => `- [${i.done ? "x" : " "}] ${c}`).join("\n")}`,
    !i.labels.includes("prep") && !i.done ? "- [ ] `pnpm check` green in CI" : "",
    deps.length ? `\n**Depends on:**\n${[...new Set(deps)].map((d) => `- ${ref(d)}`).join("\n")}` : "",
    unblocks.length ? `\n**Unblocks:**\n${[...new Set(unblocks)].map((d) => `- ${ref(d)}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
  const n = byTitle.get(i.title).number;
  const current = DRY ? null : byTitle.get(i.title);
  if (current?.body !== body) ghJson("PATCH", `${REPO}/issues/${n}`, { body });
  if (i.done && current?.state !== "closed") {
    ghJson("POST", `${REPO}/issues/${n}/comments`, { body: i.closeNote });
    ghJson("PATCH", `${REPO}/issues/${n}`, { state: "closed", state_reason: "completed" });
    console.log(`issue  ✓ #${n} closed`);
  }
}
if (!DRY) {
  const ms = gh([`${REPO}/milestones/${msByTitle.get(milestones[0].title).number}`]);
  if (ms.open_issues === 0 && ms.state === "open") { ghJson("PATCH", `${REPO}/milestones/${ms.number}`, { state: "closed" }); console.log("sprint ✓ Sprint 0 closed"); }
}
console.log(`\n${issues.length} issues in spec, ${labels.length} labels, ${milestones.length} sprints.`);
