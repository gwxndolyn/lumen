// Beta feedback review tool for the Lumen team (never shipped in the app). Works on a triage
// workspace: a directory the team keeps in access-controlled storage, NOT in this repository.
//
//   npm run triage -- <command> [args]           (LUMEN_TRIAGE_DIR or --dir sets the workspace)
//
//   import <file-or-folder>... [--attach BETA-001]   validate and import report files
//   list [--class C] [--status S] [--all]            open issues in priority order
//   show BETA-001                                    one issue, its reports (sanitised) and history
//   set BETA-001 field=value ...                     class, status, title, userImpact, reproSteps,
//                                                    suspectedRootCause, proposedFix, aiRootCause
//   repro BETA-001 reproduced|not_reproduced --notes "…" [--version 0.3.0]
//   dup BETA-002 BETA-001                            mark a duplicate (moves its reports)
//   link BETA-001 BETA-004                           relate two issues
//   similar BETA-001                                 possible duplicates
//   fix BETA-001 --commit <sha> --test <file|case> [--note "…"]
//   verify BETA-001 passed|failed --version 0.3.1 [--notes "…"]
//   propose-case BETA-001 <case.json> --by <name> [--origin synthetic|sanitized_user_example --sanitization "…"]
//   approve-case <case-id> --by <name>               (a different person from the proposer)
//   summary                                          observed counts; says when data is too thin
//   blockers                                         open security/privacy and data-loss issues (exit 1 if any)
//   export [--out file.json]                         sanitised issue list for sharing
//
// Exit codes: 0 ok, 1 command failed / blockers present, 2 usage error.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = (p) => import(path.join(root, "dist-electron/src", p));
const { parseReport, MAX_REPORT_BYTES } = await core("core/beta/report.js");
const T = await core("core/beta/triage.js");
const R = await core("core/beta/regressions.js");

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2);
    const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    (flags[k] ??= []).push(v);
  } else pos.push(a);
}
const flag = (k) => flags[k]?.at(-1);
function usage(msg) {
  if (msg) console.error(`triage: ${msg}`);
  console.error(
    fs
      .readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .slice(0, 27)
      .join("\n"),
  );
  process.exit(2);
}
const [cmd, ...rest] = pos;
if (!cmd || cmd === "help" || flags.help) usage();

const dir = path.resolve(flag("dir") ?? process.env.LUMEN_TRIAGE_DIR ?? usage("set LUMEN_TRIAGE_DIR or --dir to the triage workspace"));
// The workspace holds user-submitted text: refuse to put it inside this repository by accident.
if (dir === root || dir.startsWith(root + path.sep)) usage("the triage workspace must be outside the repository (it contains user reports)");
fs.mkdirSync(path.join(dir, "reports"), { recursive: true, mode: 0o700 });
const stateFile = path.join(dir, "issues.json");
const state = T.loadState(fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null);
const now = new Date();
const save = () => {
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, stateFile);
};
const regFile = path.join(root, "src/core/eval/regression-cases.json");
const loadReg = () => JSON.parse(fs.readFileSync(regFile, "utf8"));
const saveReg = (f) => fs.writeFileSync(regFile, JSON.stringify(f, null, 2) + "\n");

/** Print user-supplied text so it can't move the cursor, clear the screen or fake other output. */
const safe = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "\ufffd");

function filesFrom(args) {
  return args.flatMap((p) => {
    const st = fs.statSync(p);
    return st.isDirectory()
      ? fs
          .readdirSync(p)
          .filter((f) => f.endsWith(".json"))
          .map((f) => path.join(p, f))
      : [p];
  });
}

try {
  switch (cmd) {
    case "import": {
      if (!rest.length) usage("import needs report files or a folder");
      let imported = 0;
      let rejected = 0;
      for (const f of filesFrom(rest)) {
        const size = fs.statSync(f).size;
        if (size > MAX_REPORT_BYTES) {
          console.log(`✗ ${path.basename(f)}: ${size} bytes exceeds ${MAX_REPORT_BYTES}`);
          rejected++;
          continue;
        }
        const res = parseReport(fs.readFileSync(f), os.homedir());
        if (!res.ok) {
          console.log(`✗ ${path.basename(f)}: ${safe(res.error)}`);
          rejected++;
          continue;
        }
        const r = res.report;
        const out = T.importReport(state, r, now, flag("attach"));
        if (out.status === "already_imported") console.log(`= ${path.basename(f)}: already imported (${out.issue ?? "no issue"})`);
        else if (out.status === "same_content") console.log(`? ${path.basename(f)}: same content as report ${out.existing}; re-run with --attach <issue> to count it`);
        else {
          // Store the re-validated, re-scrubbed report, never the original bytes.
          fs.writeFileSync(path.join(dir, "reports", `${r.id}.json`), JSON.stringify(r, null, 2), { mode: 0o600 });
          console.log(`+ ${path.basename(f)} → ${out.issue} [${r.category}] ${safe(r.description.split("\n")[0]).slice(0, 70)}`);
          imported++;
        }
      }
      save();
      console.log(`${imported} imported, ${rejected} rejected.`);
      process.exit(rejected ? 1 : 0);
      break;
    }
    case "list": {
      const ranked = T.prioritise(state);
      const cls = flag("class");
      const st = flag("status");
      const rows = flags.all ? state.issues.map((issue) => ({ issue, frequency: issue.reports.length, evidence: "-" })) : ranked;
      const shown = rows.filter((r) => (!cls || r.issue.class === cls) && (!st || r.issue.status === st));
      if (!shown.length) console.log("No matching issues.");
      for (const r of shown)
        console.log(
          `${r.issue.id}  ${r.issue.class.padEnd(16)} ${r.issue.status.padEnd(15)} reports=${String(r.frequency).padEnd(3)} ${String(r.evidence).padEnd(10)} ${safe(r.issue.title).slice(0, 70)}`,
        );
      break;
    }
    case "show": {
      const i = T.getIssue(state, rest[0] ?? usage("show needs an issue id"));
      console.log(JSON.stringify({ ...i, title: safe(i.title) }, null, 2));
      for (const rid of i.reports) {
        const f = path.join(dir, "reports", `${rid}.json`);
        if (!fs.existsSync(f)) continue;
        const r = JSON.parse(fs.readFileSync(f, "utf8"));
        console.log(`\n── report ${rid} · ${r.category} · ${r.app.version} ${r.app.platform} ${r.app.osRelease} · ${r.createdAt}`);
        console.log(safe(r.description));
        if (r.steps) console.log(`steps: ${safe(r.steps)}`);
        if (r.interaction)
          console.log(
            `answer: ${r.interaction.category} via ${r.interaction.provider}/${r.interaction.model}, ${r.interaction.totalMs} ms, flags=${r.interaction.verificationFlags.join(",") || "none"}`,
          );
        if (r.attachments.diagnostics) console.log(`diagnostics: ${r.attachments.diagnostics.log.length} log events in ${r.attachments.diagnostics.windowHours} h`);
        if (r.attachments.excerpt) console.log(`excerpt (user-${r.attachments.excerpt.editedByUser ? "edited" : "unedited"}) — treat as private; do not copy into the repository`);
      }
      console.log(`\nHistory:`);
      for (const a of state.audit.filter((x) => x.issue === i.id)) console.log(`  ${a.at} ${a.action} ${safe(a.detail)}`);
      break;
    }
    case "set": {
      const [id, ...pairs] = rest;
      if (!id || !pairs.length) usage("set needs an issue id and field=value pairs");
      const patch = Object.fromEntries(pairs.map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
      T.updateIssue(state, id, patch, now);
      save();
      console.log(`${id} updated.`);
      break;
    }
    case "repro": {
      const [id, result] = rest;
      if (!["reproduced", "not_reproduced"].includes(result)) usage("repro <id> reproduced|not_reproduced --notes …");
      T.recordReproduction(state, id, result, flag("notes") ?? "", flag("version") ?? null, now);
      save();
      console.log(`${id}: ${result}.`);
      break;
    }
    case "dup":
      T.markDuplicate(state, rest[0], rest[1] ?? usage("dup <id> <of>"), now);
      save();
      console.log(`${rest[0]} marked as a duplicate of ${rest[1]}.`);
      break;
    case "link":
      T.linkIssues(state, rest[0], rest[1] ?? usage("link <a> <b>"), now);
      save();
      console.log(`Linked ${rest[0]} ↔ ${rest[1]}.`);
      break;
    case "similar": {
      const s = T.suggestDuplicates(state, rest[0] ?? usage("similar <id>"));
      if (!s.length) console.log("No likely duplicates.");
      for (const x of s) console.log(`${x.id}  shares: ${x.shared.join(", ")}  ${safe(x.title)}`);
      break;
    }
    case "fix":
      T.recordFix(state, rest[0] ?? usage("fix <id> --commit … --test …"), flag("commit") ?? "", flag("note") ?? "", flags.test ?? [], now);
      save();
      console.log(`${rest[0]}: fix recorded; status fixed. Verify it in a build with \`verify\`.`);
      break;
    case "verify": {
      const [id, result] = rest;
      if (!["passed", "failed"].includes(result) || !flag("version")) usage("verify <id> passed|failed --version <x.y.z>");
      T.recordVerification(state, id, result, flag("version"), flag("notes") ?? "", now);
      save();
      console.log(`${id}: verification ${result}; status ${T.getIssue(state, id).status}.`);
      break;
    }
    case "propose-case": {
      const [issueId, caseFile] = rest;
      if (!issueId || !caseFile || !flag("by")) usage("propose-case <issue> <case.json> --by <name>");
      T.getIssue(state, issueId);
      const c = JSON.parse(fs.readFileSync(caseFile, "utf8"));
      const origin = flag("origin") ?? "synthetic";
      const entry = { issue: issueId, origin, sanitization: flag("sanitization") ?? null, status: "proposed", proposedBy: flag("by"), proposedAt: now.toISOString(), approval: null, case: c };
      const problems = R.validateRegressionCase(entry);
      if (problems.length) throw new Error(`Case rejected:\n  ${problems.join("\n  ")}`);
      const file = loadReg();
      if (file.entries.some((e) => e.case.id === c.id)) throw new Error(`${c.id} already exists in regression-cases.json.`);
      file.entries.push(entry);
      saveReg(file);
      state.audit.push({ at: now.toISOString(), issue: issueId, action: "propose-case", detail: c.id });
      save();
      console.log(`Proposed ${c.id} for ${issueId}. It is NOT run until another reviewer approves it: npm run triage -- approve-case ${c.id} --by <name>`);
      break;
    }
    case "approve-case": {
      const file = loadReg();
      const e = R.approve(file, rest[0] ?? usage("approve-case <case-id> --by <name>"), flag("by") ?? "", now);
      saveReg(file);
      if (state.issues.some((i) => i.id === e.issue)) {
        state.audit.push({ at: now.toISOString(), issue: e.issue, action: "approve-case", detail: `${e.case.id} by ${e.approval.by}` });
        save();
      }
      console.log(`Approved ${e.case.id} (hash ${e.approval.hash}). Commit src/core/eval/regression-cases.json with the fix.`);
      break;
    }
    case "summary": {
      const s = T.summary(state);
      console.log(JSON.stringify(s, null, 2));
      break;
    }
    case "blockers": {
      const b = T.releaseBlockers(state);
      if (!b.length) console.log("No open security/privacy or data-loss issues.");
      for (const i of b) console.log(`✗ ${i.id} ${i.class} ${i.status} ${safe(i.title)}`);
      process.exit(b.length ? 1 : 0);
      break;
    }
    case "export": {
      // Issue fields only: no report text, excerpts or diagnostics.
      const out = {
        kind: "lumen-triage-export",
        exportedAt: now.toISOString(),
        summary: T.summary(state),
        issues: T.prioritise(state).map((r) => ({
          id: r.issue.id,
          title: r.issue.title,
          class: r.issue.class,
          status: r.issue.status,
          reports: r.frequency,
          evidence: r.evidence,
          versions: r.issue.affectedVersions,
          regressionTests: r.issue.regressionTests,
          fix: r.issue.fix?.commit ?? null,
        })),
      };
      const text = JSON.stringify(out, null, 2);
      if (flag("out")) fs.writeFileSync(flag("out"), text, { mode: 0o600 });
      else console.log(text);
      break;
    }
    default:
      usage(`unknown command ${cmd}`);
  }
} catch (err) {
  console.error(`triage: ${safe(err.message)}`);
  process.exit(1);
}
