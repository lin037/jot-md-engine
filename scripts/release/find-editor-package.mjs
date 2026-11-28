import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const [version] = process.argv.slice(2);
const editor = JSON.parse(readFileSync("packages/editor/package.json", "utf8"));
assert.match(version ?? "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
assert.equal(version, editor.version, "Release version must match packages/editor/package.json");

const { GITHUB_OUTPUT, GITHUB_REF_NAME, GITHUB_REPOSITORY, GITHUB_REPOSITORY_ID, GITHUB_SHA } = process.env;
const repositoryId = Number(GITHUB_REPOSITORY_ID);
const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
const name = `jot-editor-package-${tree}`;
const workflow = github("actions/workflows/ci.yml");
const pages = github(`actions/artifacts?name=${name}&per_page=100`, "--paginate", "--slurp");
const match = pages.flatMap(page => page.artifacts).find(isVerified);

if (match) {
  const runId = match.workflow_run.id;
  appendFileSync(GITHUB_OUTPUT, `run_id=${runId}\nartifact_id=${match.id}\n`);
  console.log(`Using verified artifact ${match.id} from CI run ${runId} for tree ${tree}`);
} else {
  console.log(`No verified artifact for tree ${tree}; CI will verify this main commit.`);
}

function isVerified(artifact) {
  if (artifact.expired || artifact.workflow_run?.head_repository_id !== repositoryId) return false;
  const run = github(`actions/runs/${artifact.workflow_run.id}`);
  if (run.workflow_id !== workflow.id || run.conclusion !== "success") return false;

  if (run.event === "workflow_dispatch") {
    return run.head_branch === GITHUB_REF_NAME &&
      (run.head_sha === GITHUB_SHA || github(`git/commits/${run.head_sha}`).tree.sha === tree);
  }
  return run.event === "pull_request" && hasMergedPullRequest(run.head_sha);
}

function hasMergedPullRequest(headSha) {
  // After a squash merge, a run's pull_requests array can be empty.
  const pages = github(`commits/${headSha}/pulls?per_page=100`, "--paginate", "--slurp");
  return pages.flat().some(pr => pr.merged_at && pr.head.sha === headSha &&
    pr.base.ref === GITHUB_REF_NAME && pr.base.repo.id === repositoryId &&
    github(`git/commits/${pr.merge_commit_sha}`).tree.sha === tree);
}

function github(path, ...options) {
  return JSON.parse(execFileSync("gh", ["api", `repos/${GITHUB_REPOSITORY}/${path}`, ...options], { encoding: "utf8" }));
}
