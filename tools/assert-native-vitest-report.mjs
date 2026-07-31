import { readFileSync } from "node:fs";

const [reportPath, dependencyName, minimumTestsText] = process.argv.slice(2);

if (!reportPath || !dependencyName || !minimumTestsText) {
  throw new Error(
    "Usage: node tools/assert-native-vitest-report.mjs <report.json> <dependency> <minimum-tests>",
  );
}

const minimumTests = Number.parseInt(minimumTestsText, 10);
if (!Number.isSafeInteger(minimumTests) || minimumTests < 1) {
  throw new Error("minimum-tests must be a positive integer");
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const counters = {
  totalSuites: report.numTotalTestSuites,
  passedSuites: report.numPassedTestSuites,
  failedSuites: report.numFailedTestSuites,
  pendingSuites: report.numPendingTestSuites,
  totalTests: report.numTotalTests,
  passedTests: report.numPassedTests,
  failedTests: report.numFailedTests,
  pendingTests: report.numPendingTests,
  todoTests: report.numTodoTests ?? 0,
};

for (const [name, value] of Object.entries(counters)) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${dependencyName} report has an invalid ${name} counter`);
  }
}

const failures = [];
if (counters.totalTests < minimumTests) {
  failures.push(`expected at least ${minimumTests} tests, found ${counters.totalTests}`);
}
if (counters.totalSuites < 1) {
  failures.push("no native test suite was executed");
}
if (counters.failedSuites !== 0 || counters.failedTests !== 0) {
  failures.push("native test failures were reported");
}
if (counters.pendingSuites !== 0 || counters.pendingTests !== 0 || counters.todoTests !== 0) {
  failures.push("native tests were skipped, pending, or marked todo");
}
if (counters.passedSuites !== counters.totalSuites) {
  failures.push("not every native test suite passed");
}
if (counters.passedTests !== counters.totalTests) {
  failures.push("not every native test passed");
}

const assertionResults = (report.testResults ?? []).flatMap(
  (suite) => suite.assertionResults ?? [],
);
if (assertionResults.some((assertion) => assertion.status !== "passed")) {
  failures.push("at least one assertion is not explicitly marked passed");
}

if (failures.length > 0) {
  throw new Error(`${dependencyName} native evidence rejected: ${failures.join("; ")}`);
}

console.log(
  JSON.stringify({
    dependency: dependencyName,
    verdict: "PASS",
    ...counters,
  }),
);
