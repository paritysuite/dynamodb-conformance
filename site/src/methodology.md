---
layout: layouts/prose.webc
# Hand-authored page: bump when the prose changes so the sitemap stays honest.
lastmod: "2026-09-20"
meta:
  title: Methodology
  description: "How the conformance figures and grades are worked out, how runs and movement are reconstructed, what the suite does and doesn't test, and the trademark attributions."
---

{% set spread = summary.latest | regionalSpread %}

# How the numbers work

The [About page](/about) covers why this exists. This one is the how: where each figure comes from, how the history is rebuilt, and - just as important - what the suite doesn't tell you.

## How a score is worked out

Every test runs against live AWS DynamoDB first. Whatever real DynamoDB does is recorded as the expected answer, and an emulator passes a test only if it gives that same answer. Real DynamoDB doesn't behave identically in every region, though, so the suite records the answer in every region it can reach and scores each target against all of them, taking its best-matching region as the headline. That's why DynamoDB sits at the top of every table diverging nowhere: each region agrees with itself, so measured against its own answers it is right everywhere. The [regional ground truth](/ground-truth) page has the why and the evidence.

The tests only ever look at observable behaviour. They drive the standard AWS SDK against the target's HTTP endpoint and assert on the response: its shape, the error returned (its type, the field and constraint it objects to, matched exactly where the wording is stable and structurally where AWS varies it), the order validation fires in. Nothing reaches inside the implementation. If your application would see it through the SDK, the suite checks it; if it wouldn't, the suite doesn't care about it.

<!-- literal-figures: structural, the three tiers are the suite's own shape, fixed in scripts/lib/score.mjs -->
Results are split into three tiers - Core, Complete, and Strict - so a single percentage can't hide a fatal gap behind a pile of passing edge cases. Each tier carries the same two figures as the headline, over that tier alone.

Every target carries two figures, and they are never added together. **Divergence** is the share of the whole suite a target answers differently from real DynamoDB. **Coverage** is the share of the suite's tests it implements at all. It is weighted by test count rather than by a count of features, so a target that declines one heavily-tested operation loses more coverage than one declining several lightly-tested ones{% if suite.available %} - `putItem` alone carries {{ suite.byOperation.putItem | formatNumber }} of the suite's tests, while `account`, `resourcePolicy` and `contributorInsights` carry {{ suite | carriedEach(["account", "resourcePolicy", "contributorInsights"]) }}{% endif %}. Read as a pair the two figures say something a single number can't: a target that diverges nowhere conforms on everything it implements, and its coverage figure is what says how much that is.

They stay apart because a skip and a fail are not the same kind of problem. A [skipped test](/about) is the target's feature-probe declining to run, because the operation isn't implemented; you find that out in minutes and plan around it. A fail means the operation is there and behaves differently from DynamoDB, which you tend to find out in production. Adding the two would price them the same.

Divergence is measured over the whole suite rather than over what a target attempts, so the denominator never moves. That gives the two figures a fixed relationship. When a target stops attempting an operation it used to get wrong, that test leaves the divergence numerator and the coverage numerator together, over the same unchanged denominator, so **both figures fall by exactly the same amount**. Withdrawal doesn't go unrecorded: it costs precisely as much coverage as it gains divergence.

<!-- literal-figures: historical, the 24 July 2026 withdrawal, a movement that is finished and dated -->
Dynalite is the live case. On 24 July 2026, 88 of its failing tests became skips. Nothing was fixed, nothing else changed, and the suite stayed at 998 tests. Its divergence fell 8.8 points and its coverage fell 8.8 points, both of them exactly 88/998. Under the correctness figure this replaced, the same act *raised* the score 8.4 points, because those 88 tests left the denominator as well as the numerator, and there was no second figure left to record what had happened.

Implementing a sliver and getting it right still reads as 0.0%, because nothing was got wrong. The coverage figure beside it is what says how thin that surface is.

The standings are ordered by divergence, which ranks how much a target gets wrong; it isn't a verdict on which emulator you should pick, because that depends on which operations you need.

<a id="grading"></a>

## How the grade is read

The letter is a reading of the two figures, and both stay printed beside it. {{ coverageShareSentence }} A target implementing the whole suite is graded on divergence alone.

<!-- literal-figures: criteria, the published bands and the A+ gate, versioned in scripts/lib/grade.mjs -->
Divergence sets the letter: **A** under 5%, **B** under 15%, **C** under 25%, **D** under 35%, **F** beyond that. **A+** is exactly zero divergence at full coverage: zero failing tests against the target's best-matching region and nothing declined, both read as counts rather than as the published percentages - one fail in a large enough suite displays as 0.0% without being zero, and a target one test short of the suite does not print 100.0% coverage. Nothing on the board holds A+ today.

Both figures print beside the letter on the standings, each target's page, the results table and the data endpoints, so you can always recompute it from the criteria below. The [badge](/for-agents) is the exception: a shields endpoint has room for a label and a message and nothing else, so it carries the letter alone.

A row says where coverage is holding its letter down, so a capped row is not mistaken for one with room above it. {{ summary.latest | cappedExamples }}

Real DynamoDB carries no letter at all. A grade reads how far a target sits from real DynamoDB, so grading the yardstick against itself seats it in a band an engine had to earn its way into. It reads `baseline` on the results table, on its badge and in the data endpoints, and it sits above the board rather than in it. Its two figures still publish, because they are the definition every other row is read against.

### The letter is weaker than the figures

Withdrawing a failing test lowers divergence and coverage by the same amount, which is what makes the pair hard to game. The letter inherits only two thirds of that, so a target that declines what it fails still gains a little. Closing the gap entirely would mean counting a declined test as heavily as a failed one, and the difference between those two is what the board is for.

**Rank on divergence and coverage, not the letter.** {{ summary.latest | cheapestWithdrawal }}

<!-- literal-figures: criteria, the published band boundaries and the weight that answers them, versioned in scripts/lib/grade.mjs -->
The divergence boundaries at 5% and 25% are the numbers this board has published as its colour bands since it began. The numbers carry over; the denominator does not. Those bands sat on correctness - 95% and 75%, over the operations a target implements - and these sit on divergence, over the whole suite. The same digits therefore cut a different line everywhere but full coverage, and the coverage weight is what answers it: a target diverging 4.9% over 92% coverage is 94.7% correct, which the old sub-95% amber band would have caught, and reads an effective 7.6 here, which grades **B**. The splits at 15% and 35% are new lines, and so is the weight.

<!-- literal-figures: illustrative, the quoted row clauses are format samples, not rows on the board -->
The grade reads the same figures as the row it sits on: the target's headline region, its best-matching one. Every target is measured against every observed region, and regions play no part in the letter.{% if spread %} Regional disagreement in real DynamoDB currently moves a figure by at most {{ spread.points }} points, across a suite of {{ spread.suite | formatNumber }} tests, so there is no region-based cap.{% endif %} Each row states its regional distribution with the figures attached - "no divergence in 6 regions · up to 0.3% in the other 26", or "low divergence (2.0%) in all 32 regions" - never as a bare count. A bare count read inverted: a target failing identically everywhere showed "32 of 32" while one perfect in six regions - and differing elsewhere only where DynamoDB differs from itself - showed "6 of 32", so the bigger number read as the better target. Paired with its figure, the count says what it means, and a zero can never read as more than the measurement: "no divergence in 6 regions" claims exactly what was observed. It is "up to" in the remainder because the remainder need not be uniform. Each target's page has the full per-region drilldown.

An A+ earned in a subset of regions cannot conceal ordinary bugs behind a friendly cohort, and that is a property of the scoring model rather than a promise. Per-region scoring only changes a verdict on a confirmed split - a behaviour where real DynamoDB's regions disagree with each other, held in the [registry](/ground-truth) with per-region evidence - so a test with no split is expected to behave identically everywhere, and a target failing it fails it in every region, the headline included. Zero divergence in the headline region therefore means the target's remaining regional differences are confined to behaviours where DynamoDB disagrees with itself. {% if spread and splits.available %}The scale is small enough to check by eye, on any row you like: no target's worst region fails more than {{ spread.tests | countWord }} tests beyond its headline, against a registry of {{ splits.count | countWord }} confirmed splits. {% endif %}A matching cohort can't be manufactured by a bad sweep either: an unresolved region is flagged and carried rather than scored, and a split enters the registry only once confirmed. As a backstop, a build-time guard asserts both halves of this: every fail a zero-divergence target records in any region must be one of the registry's split tests - checked by test identity, not by count, so unrelated fails could not hide behind a registry that happens to be the same size - and the letter the row publishes must survive its worst region. The check gates the deploy rather than running beside it, and the suite publishes the failing test identities into its results artefact so the check can reach that verdict from the registry itself rather than taking a count on trust. It runs against the committed results, not the copy a given build fetches, so it can block a publish but cannot catch a fetch that returns something the repository does not hold. If real DynamoDB's regions ever drift far enough apart to break either half, the build fails and the criteria are revisited in the open, under a bumped version.

<!-- literal-figures: criteria, the A+ gate reading raw values, versioned in scripts/lib/grade.mjs -->
Everything is rounded to the one decimal place the board publishes before the bands are read, so recomputing a grade from the figures on a row lands where the grader did. The A+ gate alone reads the raw values: a divergence that merely rounds to 0.0% earns an A, and a target one test short of the suite does not print 100.0% coverage.

Letters compress, so two things are worth knowing at the boundaries. A target sitting near a band edge can change letter on a movement of a fraction of a point; the percentage-point figures are the finer instrument, and when a letter does change between runs the row says so beside the movement (for example "C → B"). And a letter never breaks a tie: the standings are ordered by divergence, then coverage, then name, so the order is deterministic and two targets sharing a letter still sort by their figures. The "Biggest moves" chips list the three largest movements of at least 0.1 percentage points among re-tested targets.

Every letter on the board is produced by one shared function from the two published figures and nothing else - no target is graded by different rules, the [board author's own engines](/targets/dynoxide) included - and the suite's tests assert exactly that: the published grade must equal the one recomputed from the row's own divergence and coverage. A row with no cap clause is a letter set by its divergence band alone.

These are **grading criteria version {{ gradingCriteria.version }}**, in effect from {{ gradingCriteria.effectiveLabel }}. Retuned thresholds move published grades on targets that changed nothing - the documented failure mode of every graded system - so any change to the bands, the coverage weight or the A+ gate bumps the criteria version and is dated here. The criteria also travel machine-readably in every [data endpoint](/for-agents)'s `metrics.grade`.

A grade is an observation, not a certificate. It grades observed behaviour against this suite's published tests on a named date, in the regions named beside it. It is not an audit of production readiness, not a compatibility certification, and not an endorsement of any target.

The two figures are not properties of the same thing. Coverage is a property of the target: which of the suite's tests it implements at all doesn't depend on which region it is compared against, because scoring a target against a region only ever turns one of its passes into a fail or back again - a skip stays a skip everywhere. Divergence is a property of the target *measured against a region*, so it is the one figure a target's headline region decides. Every figure on a row comes from that same region, and the row names it, so a target's fails divided by the suite size always reproduces the divergence printed beside them.

<!-- literal-figures: historical, suite sizes at two named points in 2026, quoted to show the growth -->
One consequence worth spelling out: [the suite grows](/changelog). It had 526 tests in March 2026 and over 600 by May. Raw counts from different runs aren't comparable, so every chart and every movement figure on this site is a **percentage**, never a count.

## When a project has more than one build

Some projects ship the same engine in more than one shape: a storage backend swapped underneath it, or the query layer compiled for somewhere else to run. Those builds are nested under the project rather than seated beside it, because a reader chooses between projects first and the build follows from where their code runs. Seating them as rivals would let one engine take several places near the top.

Every build is measured in full, and every build has its own row, its own figures and its own page. The nesting decides only how much of that you see at once: a project's other builds sit behind a disclosure on its row, which starts closed only when every build under it reads the same grade, divergence and coverage as the row above. A build repeating all three is a click away rather than three more lines of the same numbers, and one that differs is already showing - along with its siblings, since the disclosure opens as a whole.

Three things have to hold for a build to start closed, not one. The figures have to match. Both builds have to have been measured in the run being shown, on either side: a row carried from an earlier run has its figures frozen at the run that measured it, so a carried build, or a carried project row above it, opens the disclosure whatever the percentages say. And neither can be a row the suite declined to score, because a run that recorded a failed observation publishes no figures at all and two blanks are not agreement.

The second clause has a visible consequence worth naming: on a run where a project itself was not re-tested, every one of its builds shows open, even builds whose figures are identical to the row above them. That reads like a fault and is the opposite - it is the board declining to say two things agree when it has not measured them together.

What is compared is what the row prints: the grade, the divergence and the coverage. Not the version, the region cohort or the tier breakdown. So a closed disclosure says those three read the same, which is what its summary says, and no more than that.

The comparison is made from each run rather than from a setting anyone maintains, so it goes both ways: a build that converges with the one above starts closed on the next run, and one that later diverges starts open again. It picks a starting state and nothing else, so no figure is withheld by it either way.

The README table in the suite repository has no disclosure to offer, so it lists every build outright.

## How runs and movement are reconstructed

The suite publishes each run's results as JSON in its repository, and it has done since the first run. That means the full history is sitting in the git log, and this site rebuilds the timeline from it: it reads every version of those result files, scores each one with the suite's own logic, and assembles the runs you browse here.

A "run" is defined by the timestamp stamped into each result file, grouped by date - not by commit. That distinction matters more than it sounds. A single commit often refreshes only some targets, and one commit can carry results that were actually produced in different runs, so grouping by commit would invent runs that never happened and stitch unrelated results together. Grouping by date is robust to both, even when one run's targets finish over an hour apart.

When a target isn't re-tested in a run, its last measured result is carried forward and labelled as such, rather than dropped or silently restated as fresh. **Movement** compares a target against the previous run it was actually tested in, so the arrow always means "since last measured", never "since some run where nothing changed".

This site and the suite are one repository, and the scoring is shared code rather than a copy of it. The target list, the display names, the project links and the pass-rate arithmetic are imported from the suite's own modules, so adding a target or correcting a name happens once and lands in both places. What the site still renders on its own - assembling a scored run into the rows you see - is held to the suite's published per-region summary by a test.

That arrangement exists because the rule behind the whole site is that a target's figures are derived, never typed. The moment the same number lives in two places it starts to drift, and a number that has quietly drifted is worse than no number at all. When the two lived in separate repositories a new target was added to the suite a day before the site learned its name, and for that day the comparison was wrong.

What is not derived is disclosed where it applies. The [grade bands and the split registry](/about#on-independence) are hand-picked inputs and always will be. The baseline row is a conditional case rather than a standing exception: real AWS is measured in three passes, and while any of them is outstanding the row is pinned to its last clean measurement instead of being derived from the current one. The [ground truth](/ground-truth) page names the passes that have reported and what they were measured on, so it says which of those the row is standing on today rather than leaving you to assume.

What you can reproduce is the scoring. Clone the repository, run the scorer over the committed results, and you get the figures published here, test by test. A local build of the site renders a smaller thing: it assembles the timeline by fetching the history of `results/` from the API, and without a token that fetch falls back to a committed snapshot. The deploy sets `FAIL_ON_FALLBACK` so a scheduled build refuses the snapshot rather than quietly publishing a thinner board.

## Limitations

A score here is a useful signal, not a certificate. Worth keeping in mind:

- **It only tests what it tests.** A behaviour with no test is a blind spot, not a pass. The suite is broad and growing, but "0.0% Tier 1" means "nothing wrong among the Tier 1 tests that exist", not "every Core behaviour DynamoDB has".
- **The headline is tier-level; the per-operation detail is a click away.** The top-line number rolls up to per-tier percentages, so at a glance you see a target is weak on Tier 2, not which operation. Each target page then breaks its score down by operation, on the same divergence and coverage axes, the [emulator directory](/targets) lists feature and operation support for each project, and the failing tests are listed by name. The [suite's repo](https://github.com/paritysuite/dynamodb-conformance) has the raw per-test results behind all of it.
- **Every result is a point in time, and a place.** A score is tied to the version of the target tested on that date, against DynamoDB's behaviour on that date - and DynamoDB's behaviour is neither identical across regions nor fixed over time. In June 2026, for instance, a `PutItem` with a `{ NULL: false }` attribute was accepted in eu-west-2 and eu-central-1 but rejected in us-east-1 and others; by mid-July the regions had converged again. The suite scores against every region it can reach and headlines the best match, so a score means conformance to real DynamoDB as it behaved across the regions on a named date. Both sides move.
- **Behaviour only, nothing else.** The suite says nothing about performance, scalability, durability, cost, or operational fit. An emulator can match DynamoDB's behaviour perfectly and still be the wrong tool for your job, or the right one despite a worse figure here.
- **A skip is recognised from the target's own answer, not declared.** Each test file probes for support before running, and the probe reads the target's response: an `UnknownOperationException`, a message matching `unknown operation`, `not implemented`, `unsupported operation` or `is not supported`, or an HTTP 501. Anything else arrives as an ordinary error and the test is scored as a failure. That matters because the same classification decides both published figures and the order of the board: a target that declines an operation in wording the probe doesn't recognise has its divergence inflated and its coverage overstated, and one that returns a 501 for an operation it half-implements has both understated. If a target's figures look wrong to its maintainer, this is the first thing to check.
- **Configuration matters.** Targets are tested in a representative setup. A differently configured deployment may behave differently.

## Trademarks and attribution

Amazon DynamoDB, DynamoDB, and AWS are trademarks of Amazon.com, Inc. or its affiliates. This is an independent project and is not affiliated with, endorsed by, or sponsored by Amazon, and nothing here grants any right to use those names or marks. DynamoDB Local, Dynalite, LocalStack, Ministack, Floci, ExtendDB, Kumo, and every other target named on this site are the trademarks or property of their respective owners.

The conformance suite is the work of [Martin Hicks](https://martinhicks.dev) and its contributors, released under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0); see the [NOTICE](https://github.com/paritysuite/dynamodb-conformance/blob/main/NOTICE) for the full attribution. This site is built from the same repository, under the same licence, and is maintained by [Martin Hicks](https://martinhicks.dev). The fonts it uses, Inter and JetBrains Mono, are licensed separately under the SIL Open Font License 1.1.
