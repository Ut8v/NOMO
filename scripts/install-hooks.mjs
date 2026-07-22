import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Best effort: source archives have no .git directory, and npm install must
// still succeed there. The CI guard covers commits made without the hook.
if (existsSync(".git")) {
  try {
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
  } catch {
    console.warn("Could not set core.hooksPath; install the pre-commit hook manually.");
  }
}
