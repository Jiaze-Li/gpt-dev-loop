# Executor Context Optimization

## Repeatable live acceptance proof

Run `node scripts/run-final-e2e.js` to create a disposable two-task repository and execute it through the production provider path. The command fails unless the workflow reaches `WORKFLOW_DONE`, every task review is `PASS`, no `HUMAN_REQUIRED` transition occurs, and at least two Executor calls contain provider-reported input/output usage plus a complete five-category breakdown that exactly reconciles to provider input.

The terminal report includes workflow ID; every Executor call's task, attempt, input, cached, output, and category composition; optimized totals; and absolute/percentage comparison with the supplied baseline calls (358798, 326247, 631654, 744442; total 2061141). Cached tokens are reported as a subset of input and never added to the component total. Missing credentials or provider telemetry causes failure rather than substitution with fabricated measurements.
