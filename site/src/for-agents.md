---
layout: layouts/prose.webc
# Hand-authored page: bump when the prose changes so the sitemap stays honest.
lastmod: "2026-08-18"
meta:
  title: For agents
  description: "How to read Parity Suite's conformance scores, and where to get them as machine-readable data, for agents and anyone consuming the suite programmatically."
---

# Reading these scores

This page is for anyone consuming the suite programmatically - an agent, a dashboard, a script - and for anyone who wants to read a number here and know exactly what it means. A single percentage is easy to misread as a verdict, so here's how the figures are built and where to get them as data.

## Get the data, don't scrape the page

Every figure on the site is published as JSON, regenerated at build time from the same results the pages render from. Read that instead of parsing HTML:

- [/data/latest.json](/data/latest.json) - the latest run in full: every target's divergence and coverage, overall and per tier, its per-capability and per-operation-area state, and the full per-region breakdown, alongside the run's region health.
- [/data/runs.json](/data/runs.json) - the whole history, newest first: per-target divergence and coverage, overall and per tier, plus run-over-run movement and headline region for every recorded run. Each run carries `gradedUnderCriteria` and `suite`, the measurement identity for that run - so a denominator that moved between two runs can be attributed to the release that moved it, not just observed. `suite` is null for runs measured before the identity was published. Every target in it carries a letter regardless, computed under the criteria in force now; the feed instead withholds the letter on those runs, because a feed entry is archived by other people and keeps its original timestamp. The flag says which you are reading, and `metrics.grade.effective` is the date it turns on.
- [/data/index.json](/data/index.json) - a discovery manifest: the tier, capability and region vocabularies, where each endpoint lives, and the licence.
- [/feed.xml](/feed.xml) - an Atom feed, one entry per run. Entries for runs measured before criteria version 1 took effect carry no letter, because none was published at the time; they say so in the summary and carry `<category term="ungraded"/>`, so a single entry read on its own is not ambiguous. Their `<updated>` is unchanged, so if you archived those entries when they were first published, the letters you may have seen in an earlier copy of this feed were applied retroactively and have been withdrawn.
- [registry/splits.json](https://raw.githubusercontent.com/paritysuite/dynamodb-conformance/main/registry/splits.json) - the behaviours where real AWS regions genuinely disagree, each with every region's recorded answer and the pinned one. Served from the suite repo rather than this site, because it is the suite's artefact. You need it to check the A+ premise for yourself: a zero-divergence target may fail a test in a non-headline region only where that test is recorded here.

<!-- literal-figures: structural, the three real-AWS lanes are the pipeline's own shape -->
The baseline's `observation` block, in every endpoint's envelope, says how much of the suite that row is currently standing on. Real AWS is measured in three passes for runtime reasons, and until all three have reported the row is pinned to its last clean measurement rather than derived: `lanes` is what has reported and when, `missingLanes` names what has not, and `unobserved` counts the tests carried rather than re-observed.

Every target carries the identical schema, live AWS DynamoDB included. The data is published under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): use it freely, just credit paritysuite.org. The schema is versioned with a `schemaVersion` field, and what it entitles you to is this: a field you already read will not change type or meaning while the number stays put. New fields can appear at any version, so treat one you do not recognise as new rather than as an error - removals, renames and changes of meaning are what bump it. The grading criteria are a separate axis: they carry their own version, and a change to the bands changes what a letter means without `schemaVersion` moving, so anything storing letters over time should watch both. The `schema` block in [/data/index.json](https://paritysuite.org/data/index.json) says the same thing where a machine reader will find it.

Every board says what produced it. The `suite` block, on the board and in [/data/index.json](https://paritysuite.org/data/index.json), names the ref measured, its commit, the suite version at that ref, the region measured against, and when. Branch on `kind`: `tag` means a released suite with a dated changelog entry behind it, and anything else means the board was measured from an unreleased commit - treat its figures as provisional and do not compare them against a released board's. A board written before this field existed carries no `suite` block at all, which means not stated rather than not released. A board is graded against the suite manifest and split registry as they stood at that ref, so the denominator moves when a release moves it and not when `main` does. Region health is the exception and is read live, so a board's cohorts can be recomputed after its measurement without the measurement changing - which is why the timestamp describes the measurement rather than the figures. An identical `suite.commit` is not a promise of identical figures: the oracle is live AWS rather than a fixture, and an old tag can be deliberately re-measured, so two boards naming the same commit are independent observations rather than reproductions of each other. `region` and `measuredAt` are what tell them apart.

A project can ship several builds of one engine, and each is its own target with its own figures: `project` groups them, `configuration` names what distinguishes each one, and `isVariant` says a target is a build rather than its project's reference build, and `standsForProject` says which row the board treats as the project's own. Prefer `standsForProject` when you want the project's headline: on a run where the reference build recorded nothing, a build is promoted to stand for the project and every row of it reads `isVariant: true`. Every build has its own row on the board too, but a project's other builds sit behind a disclosure there, and `collapsedIntoProject` is true when that disclosure starts closed. That takes three things: the build reads the same grade, divergence and coverage as the row `standsForProject` names, which is normally the reference build but is a promoted build on a run the reference build did not record; both were measured in that run, on either side, since a carried row's figures are frozen at the run that measured it; and neither is a row the suite declined to score. It is one answer for the project rather than per build, because the disclosure opens as a whole, so a project whose builds disagree reads false on all of them. Do not read it as a data-quality signal: it is re-derived every run and says only what the board did with the row.

Every endpoint also carries a `metrics` block naming each published figure, its formula and its `direction` (`lower_is_better` for divergence, `higher_is_better` for coverage and correctness). Read the direction from there rather than assuming it. Schema 3 reversed which way is good, and a consumer that re-derived its own ranking on the old assumption would have inverted with nothing in the shape of the data to catch it.

## Badges

Each target also has a shields.io endpoint badge, served from the suite repo so a target's own README can show its live grade without copying a figure that goes stale:

```
https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/paritysuite/dynamodb-conformance/main/results/<slug>.badge.json
```

The slug is the target's slug on this site (`dynalite`, `localstack`, `dynoxide`, and so on), and the baseline's badge reads `baseline` rather than a letter. The path is the contract: it stays put, and what changes is the `message` inside it. It carries the letter grade under a `parity` label, and until {{ gradingCriteria.effectiveLabel }} it carried the retired correctness percentage under a `conformance` label - so if your alt text still says "conformance", it is describing a badge that no longer exists. The `schemaVersion` in the file is shields.io's own and is always `1`. It says nothing about this project's schema, and a badge has no other version channel, which is why the path is the one that has to hold.

## What a score actually is

Every target carries two figures over the whole suite. **Divergence** is failed divided by total: how much of DynamoDB's behaviour the target answers differently, so lower is better. **Coverage** is implemented divided by total: how much of the suite's tests it implements at all, so higher is better. Read both. A target with a thin surface that gets it right shows a low divergence and a low coverage, and folding them into one number would lose that.

The denominator is the same for both and never moves, which fixes their relationship: a test that goes from failing to skipped leaves both numerators at once, so divergence and coverage fall by exactly the same amount. If you are tracking a target over time, a divergence fall matched by an equal coverage fall is a withdrawal, not a fix.

The JSON keeps the raw counts (`passed`, `failed`, `skipped`, `implemented`, `total`) alongside both, so you can derive whatever figure you need rather than depending on the one the board leads with. The pass rate over implemented operations is still published, as `correctness`, for consumers that already read it. It used to be `total`, which is also the name of the raw test count in `counts`, so the same word meant a count in one place and a percentage in another.

<!-- literal-figures: structural, the two ungraded row kinds are fixed in scripts/lib/grade.mjs -->
From schema 4 each target also carries a `grade`: a letter (`A+` to `F`), a plain-language `qualifier`, a `band` (the colour tier: `pass`, `partial`, `fail` or `none`), a `capped` flag and a `capAt` letter. Two rows carry `letter: null` and must be handled before you recompute anything, because a literal reimplementation of the bands mis-grades a null (`null < 5` is `true` in JavaScript): a target with nothing scored has `qualifier: "not scored"`, and the live-AWS baseline has `qualifier: "baseline"`. The baseline is not graded at all. A letter reads how far a target sits from real DynamoDB, so there is nothing for the yardstick to measure against itself; its two figures still publish, and they are the definition every other row is read against.

<!-- literal-figures: illustrative, an invented target carrying no claim about the board -->
`capped` says whether coverage lowered the letter, and `capAt` is that lowered letter - so a target diverging 12.3% (the B band on divergence alone) over 80.0% coverage reads `capped: true, capAt: "C"`, and cannot read better than C until its coverage rises. The two carry the same fact: `capAt` is the letter whenever `capped` is true and null otherwise, so test `capped` and read `capAt`. Where coverage binds nothing they are `false` and `null`. Two rows sharing a letter are not comparable when one of them is at a ceiling.

One property the letter does not inherit from the figures. Divergence cannot be lowered by declining operations without coverage falling by exactly as much, which is what makes the pair hard to game. The letter is weaker: a third of whatever a target leaves unimplemented is added to its divergence before the bands are read, so withdrawing a failing test still moves the effective figure down by two thirds of what left. Withdrawal costs more than it used to and is not free of gain. **If you are ranking targets programmatically, rank on `divergence` and `coverage`.** The letter is for reading, and the two figures are what carry the guarantee.

A letter change between tested runs travels as `movement.gradeChange` (`{from, to, label}`), null when the letter held. Two more fields keep the data at parity with the cards: `runDate` is the run that actually measured the row (it lags the run's own date when a target was carried forward untested), and `region.worst` is the worst observed region's divergence - the figure behind a row's "up to X% in the other N" clause - null when the target has no regional spread.

The grade is a reading of the two figures, never a blend of them - divergence sets the letter, with A+ meaning exactly zero failing tests against the target's headline region and nothing declined, both read as counts rather than as the published percentages, and low coverage can only cap it - and the full criteria (bands, the A+ gate, the coverage divisor) travel in `metrics.grade`, versioned as `gradingVersion` separately from the schema, because a criteria change regrades targets whose figures didn't move. Recompute the letter from the two values if you need to check it; the [methodology](/methodology#grading) has the same criteria in prose. A grade is an observation against this suite's tests on a named date, not a certification, and not an endorsement.

[Skips are scope, not failure.](/about) A skipped test is the target's own feature-probe declining to run because it doesn't implement that operation at all. That's kept out of the score and reported separately. A fail means the operation is there and behaves differently from real DynamoDB, and that counts. They mean opposite things, so don't fold skips into a pass rate.

<!-- literal-figures: illustrative, an invented target beside the suite's own three tiers -->
There are [three tiers](/about) - Core, Complete and Strict - and one figure over the whole suite hides too much. A target diverging 8% overall might be right about every Core operation and wrong about a fifth of Strict, or the reverse, and those are different problems. Each tier carries divergence and coverage on the same terms as the headline: lower is better for every divergence figure, and higher is better for every coverage one. If a user only needs everyday CRUD, the Core figure is the one that matters; if they assert on error behaviour in CI, Strict is where a gap bites. Read the tier that maps to what they actually do.

<!-- literal-figures: structural, the baseline agrees with itself by definition rather than by measurement -->
DynamoDB sits at the top of every table at 0.0% divergence over full coverage, and wears no letter. That's the baseline, not a competitor that happened to win: it's the thing everything else is measured against, so it agrees with itself by definition, and grading it would seat the yardstick in a band an engine had to earn its way into.

## What the numbers don't tell you

A score is tied to a target version, tested on a date, against DynamoDB's behaviour on that date. DynamoDB is neither identical across regions nor fixed over time, so the suite scores each target against every region it can reach and headlines its best-matching one; a figure here means conformance to real DynamoDB as it behaved across the regions on a named date, nothing wider. Both sides move. The [regional ground truth](/ground-truth) page has the detail.

And it's behaviour only. The suite says nothing about performance, scalability, durability, cost, or operational fit. A target can match DynamoDB's behaviour perfectly and still be the wrong tool for a job, or the right one despite a worse figure here. The [methodology](/methodology) has the full limitations.

## Comparing on a capability

If a decision hangs on a specific feature - PartiQL, transactions, GSIs, LSIs, streams, TTL - don't read off the headline. The [capabilities page](/targets#capabilities) lays out every target against the same capability columns, and the same data is in the `capabilities` array for each target in [/data/latest.json](/data/latest.json). Pull the column for the feature you care about and read every target's state on it. The suite scores each target against real DynamoDB, never against each other, so the comparison is like-for-like.

The site won't tell you which target to pick. It gives you the evidence per target, on equal terms.

## Who maintains this

The suite and this site are built and maintained by [Martin Hicks](https://martinhicks.dev), who also maintains Dynoxide, one of the targets scored here. That relationship is why nothing on the site is hand-authored: every figure is derived from the suite's own published results at build time, and the [scoring logic is shared with the suite](/methodology) rather than restated here. A target's score can't be tuned without changing the suite's published results first, in the open, and the tests, the results and the code that scores them are all in [one public repository](https://github.com/paritysuite/dynamodb-conformance) you can clone and run. Real DynamoDB is the baseline, every figure carries the region and date it was measured, and [suggesting a target](https://github.com/paritysuite/dynamodb-conformance/issues) is an open GitHub issue away.
