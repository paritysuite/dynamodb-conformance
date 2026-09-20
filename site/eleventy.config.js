import { formatNumber } from "./lib/numbers.mjs";
import { RenderPlugin } from "@11ty/eleventy";
import pluginWebc from "@11ty/eleventy-plugin-webc";
import anchor from "markdown-it-anchor";
import syntaxHighlight from "@11ty/eleventy-plugin-syntaxhighlight";
import { chartGeometry } from "./lib/chart.mjs";
import { renderTargetOperations } from "./lib/matrix.mjs";
import { renderFeatureSummary, renderTargetCapabilities } from "./lib/capabilities.mjs";
import { controlObservation, controlProvenance, controlSplit, regionCount, regionLabel, renderRegionGroups } from "./lib/summary.mjs";
import { renderSplitEvidence, splitCoverageNote } from "./lib/splits.mjs";
import { regionalSpread, renderCappedExamples, renderCheapestWithdrawal } from "./lib/worked-examples.mjs";
import { carriedEach, countWord } from "./lib/suite-shape.mjs";
import { GRADING_CRITERIA_EFFECTIVE, GRADING_VERSION, TARGETS, capClauseOf, configurationOf, coverageShareSentenceOf, display, distributionOf, fallsShort, gradeForRow, gradeLegendOf, gradeLineOf, gradeOf, gradingCriteriaEffectiveLabel, isSelfMaintained, isVariant, notAttempted, projectOf, regionClauseOf, scoredOnCorrectness } from "./lib/scoring.mjs";
import { channelIcon } from "./lib/channel-icons.mjs";
import { targetLinks, targetRunHref } from "./lib/links.mjs";
import { areaFailures, sourceUrl } from "./lib/findings.mjs";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// 2026-05-23 -> "23 May 2026". A named function as well as a filter, so the
// helpers that build a dated sentence in JS format the date the same way the
// templates do.
function dateLabel(iso) {
  if (!iso || iso === "-") return "-";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(pluginWebc, {
    components: "src/_includes/components/**/*.webc",
  });

  eleventyConfig.addPlugin(syntaxHighlight);
  // Lets llms-full.txt run the prose pages through the template engine before
  // concatenating them. Without it the corpus shipped the raw {{ }} source of
  // every interpolation those pages carry.
  eleventyConfig.addPlugin(RenderPlugin);

  // Every heading gets an id, so any section can be linked to without someone
  // hand-writing an anchor first. The two that already exist stay: they are
  // published URLs, and their slugs are not what the heading text would give.
  eleventyConfig.amendLibrary("md", (md) => md.use(anchor, { level: [2, 3, 4] }));

  eleventyConfig.addPassthroughCopy({
    "src/images": "images",
    "src/fonts": "fonts",
    "src/robots.txt": "robots.txt",
  });

  // The stylesheet is cache-busted with a content hash by scripts/fingerprint-css.mjs
  // after the CSS is built (it can't be hashed here: Tailwind builds it by
  // scanning the rendered HTML, so it doesn't exist yet at this point).

  // "{left} | Parity Suite", brand always the suffix. The home page's left side
  // leads with the descriptor (its meta.title), target pages phrase the intent
  // question people actually search, and subpages carry their own name.
  eleventyConfig.addFilter("pageTitle", (title, siteTitle) => {
    return title && title !== siteTitle ? `${title} | ${siteTitle}` : siteTitle;
  });

  // Used across run and target pages.
  eleventyConfig.addFilter("dateLabel", (iso) => dateLabel(iso));

  eleventyConfig.addFilter("formatNumber", (n) => formatNumber(n));
  eleventyConfig.addFilter("dump", (obj) => JSON.stringify(obj));

  // YYYY-MM-DD for sitemap <lastmod>. Degrades to "" on a bad/missing date
  // rather than throwing "Invalid time value" and failing the whole build.
  eleventyConfig.addFilter("isoDate", (d) => {
    const t = new Date(d);
    return Number.isNaN(t.getTime()) ? "" : t.toISOString().slice(0, 10);
  });

  // Full RFC3339 datetime for the Atom feed.
  eleventyConfig.addFilter("isoDateTime", (d) => {
    const t = new Date(d);
    return Number.isNaN(t.getTime()) ? "" : t.toISOString();
  });

  // Inline-SVG chart geometry for a target's percentage history.
  // Forwards every argument, not just the series. Written as `(series) => ...`
  // it silently dropped the options object, so the target page's two plots -
  // divergence and coverage - both fell back to the divergence default and
  // rendered as the same chart twice, with no error anywhere.
  eleventyConfig.addFilter("chartGeometry", (...args) => chartGeometry(...args));

  // A single target's per-operation scorecard (every area, grouped by tier, with
  // state and divergence) for its target page and its directory entry.
  eleventyConfig.addFilter("targetOperations", (areas) => renderTargetOperations(areas));

  // Capability support, in the two shapes the redesign renders it: the compact
  // per-group list on a project's directory entry, and the fuller card on the
  // target's own page. The cross-target grids that backed /capabilities and
  // /support went when those pages became redirects to the directory.
  eleventyConfig.addFilter("featureSummary", (target, group) => renderFeatureSummary(target, group));
  eleventyConfig.addFilter("targetCapabilities", (target) => renderTargetCapabilities(target));

  // Newest-first views of a series without mutating the model.
  eleventyConfig.addFilter("reversed", (arr) => [...(arr || [])].reverse());

  // Display text for a target's headline-region cohort (e.g. "all regions",
  // "eu-west-2 + 5 regions"). Delegates to the same helper the model uses so the
  // phrasing is identical everywhere.
  eleventyConfig.addFilter("regionLabel", (label) => regionLabel(label));
  eleventyConfig.addFilter("regionCount", (label) => regionCount(label));
  // What the real-AWS run observed, and which lanes it came from. The strip
  // used to read the pinned baseline row and so claimed the whole suite for a
  // run that recorded less.
  eleventyConfig.addFilter("controlObservation", (groundTruth) => controlObservation(groundTruth));
  eleventyConfig.addFilter("controlProvenance", (obs) => controlProvenance(obs, dateLabel));
  eleventyConfig.addFilter("controlSplit", (obs) => controlSplit(obs));

  // Whether a target is maintained by the board's own author (a static fact, not
  // a per-run figure), so the conflict-of-interest disclosure renders from the
  // slug at build time and never depends on the data being freshly fetched.
  eleventyConfig.addFilter("isSelfMaintained", (slug) => isSelfMaintained(slug));
  // The letter grade for a row's two published values, derived at render time
  // so a letter can never disagree with the figures printed beside it. The
  // two copy helpers keep the phrasing identical on every surface that
  // prints it (standings, variant rows, other-builds cards).
  eleventyConfig.addFilter("gradeOf", (divergenceValue, coverageValue) => gradeOf(divergenceValue, coverageValue));
  // Prefer this over gradeOf in a template: it carries the baseline exemption.
  eleventyConfig.addFilter("gradeForRow", (row, slug) => gradeForRow(row, slug));
  eleventyConfig.addFilter("gradeLine", (row) => gradeLineOf(row));
  eleventyConfig.addFilter("regionClause", (row) => regionClauseOf(row));
  eleventyConfig.addFilter("capClause", (row, slug) => capClauseOf(row, slug));
  // The legend, derived from the criteria so the block a reader checks a letter
  // against cannot fall behind the letters.
  eleventyConfig.addGlobalData("gradeLegend", () => gradeLegendOf());
  eleventyConfig.addGlobalData("coverageShareSentence", () => coverageShareSentenceOf());
  // The criteria's version and effective date, from the suite's constant. Five
  // pages stated the date in prose and would have drifted apart one edit at a
  // time; the feed also reads it as a predicate, so a page disagreeing with it
  // would caption one thing while the feed did another.
  eleventyConfig.addGlobalData("gradingCriteria", () => ({
    version: GRADING_VERSION,
    effective: GRADING_CRITERIA_EFFECTIVE,
    effectiveLabel: gradingCriteriaEffectiveLabel(),
  }));
  eleventyConfig.addFilter("configurationOf", (slug) => configurationOf(slug));
  eleventyConfig.addFilter("isVariant", (slug) => isVariant(slug));
  // A build's own page names the project it is a build of and links back to it.
  // These two give it the way there.
  eleventyConfig.addFilter("projectOf", (slug) => projectOf(slug));
  eleventyConfig.addFilter("display", (slug) => display(slug));
  // Whether this row is the one that stands for its project on a board. Not the
  // same question as whether its slug is a build: when the reference build has
  // no result the grouping promotes another to stand in, and reading the slug
  // dropped the whole project. Three templates ask this, and two of them were
  // still asking it the old way after the first was fixed - so it is a filter
  // rather than an expression repeated per template. The slug stays as the
  // reading for a model restored from the committed fallback, which predates
  // the flag; drop that half once a regenerated snapshot carries it.
  eleventyConfig.addFilter("standsForProject", (row) => row?.isParent ?? !isVariant(row?.slug));
  // A project's other builds. Every one of them, always: the disclosure below
  // decides how much is shown at once, never which of them exist.
  eleventyConfig.addFilter("buildsOf", (row) => row?.variants ?? []);
  // Whether the disclosure starts open. Open when any build reads different
  // figures from the row above it, and open when the model carries no flag at
  // all - a snapshot restored from the committed fallback predates it, and the
  // safe reading of "unknown" is to show everything.
  eleventyConfig.addFilter("buildsStartOpen", (row) =>
    (row?.variants ?? []).some((v) => v.collapsed !== true),
  );
  // What is inside, for the closed state. Names rather than a count: "SQLite"
  // tells a reader more than "1 other build" for the same room.
  eleventyConfig.addFilter("buildNames", (row) => {
    const names = (row?.variants ?? []).map((v) => configurationOf(v.slug) || v.display);
    return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  });
  // Every way a target can be run, as marks. Uncapped: seeing all of them at a
  // glance is the point, and an icon costs a fraction of the room a label does.
  eleventyConfig.addFilter("channels", (slug) =>
    distributionOf(slug)
      .map((d) => ({ ...d, ...channelIcon(d.channel) }))
      .filter((d) => d.path));
  // What a target needs before it will run, and any caveat about running it.
  eleventyConfig.addFilter("requires", (slug) => TARGETS[slug]?.requires ?? null);
  eleventyConfig.addFilter("runNote", (slug) => TARGETS[slug]?.note ?? null);

  // A target's project site and source, split out of the single URL the suite
  // carries. Static per target, like the disclosure above.
  eleventyConfig.addFilter("targetLinks", (slug, repoUrl) => targetLinks(slug, repoUrl));

  // Grouped-by-rate per-region drilldown for a target page (HTML, because WebC
  // can't nest the groups-then-regions loop).
  eleventyConfig.addFilter("regionGroups", (regions) => renderRegionGroups(regions));

  // One confirmed regional split rendered as region cohorts, for the explainer's
  // live evidence (HTML, same nesting reason as the drilldown).
  eleventyConfig.addFilter("splitEvidence", (split) => renderSplitEvidence(split));
  // The arithmetic under the cohorts: which observed regions the split does
  // not account for, so the counts do not read as regions gone missing.
  eleventyConfig.addFilter("splitCoverageNote", (split, observed) => splitCoverageNote(split, observed));

  // The methodology's worked examples, chosen from the board they describe
  // rather than named in prose. Typed in, they went stale within a fortnight and
  // ended up contradicting the standings a click above them.
  eleventyConfig.addFilter("cappedExamples", (model) => renderCappedExamples(model));
  eleventyConfig.addFilter("cheapestWithdrawal", (model) => renderCheapestWithdrawal(model));
  // How far the regions disagree about any one target, in tests and in points:
  // the residue the split registry has to account for.
  eleventyConfig.addFilter("regionalSpread", (model) => regionalSpread(model));
  // Counts the coverage-weighting sentence states, read from the suite manifest.
  eleventyConfig.addFilter("carriedEach", (shape, names) => carriedEach(shape, names));
  eleventyConfig.addFilter("countWord", (n) => countWord(n));

  // The suite's test titles carry em dashes; nothing on this site does. They are
  // normalised to a spaced hyphen on the way out, wording otherwise untouched.
  eleventyConfig.addFilter("tidyDashes", (s) => String(s).replace(/\s*—\s*/g, " - "));

  // Templates explain themselves at length, and WebC passes HTML comments
  // straight through, so the rationale was shipping to every visitor: 19% of
  // the built HTML, and 31% of a run page. The comments stay in the source and
  // stop at the build. Conditional comments are left alone, and so is anything
  // inside <pre>, where a comment would be content rather than an aside.
  //
  // The text corpus is covered too. It is assembled from the same prose sources
  // and skipping it shipped their build-time markers to the one surface an agent
  // reading text rather than JSON consumes - the same page/format split that let
  // four raw interpolations through before it.
  eleventyConfig.addTransform("stripComments", function (content) {
    const out = this.page.outputPath || "";
    if (!out.endsWith(".html") && !out.endsWith(".txt")) return content;
    // A NUL-delimited placeholder, because a bare number would collide with
    // one already on the page and swap it for a code block.
    const pre = [];
    return content
      .replace(/<pre[\s\S]*?<\/pre>/g, (m) => `\0${pre.push(m) - 1}\0`)
      .replace(/<!--(?!\[if)[\s\S]*?-->/g, "")
      .replace(/\0(\d+)\0/g, (_, i) => pre[Number(i)]);
  });

  // Where a standings row links (that run's target view, or the current page),
  // the findings for one operation area, and a test's source pinned to the
  // commit that measured it.
  eleventyConfig.addFilter("targetRunHref", (row, runId) => targetRunHref(row, runId));
  eleventyConfig.addFilter("areaFailures", (area, findings) => areaFailures(area, findings));

  // A target's gaps, split by kind: what it gets wrong, and what it never tries.
  eleventyConfig.addFilter("fallsShort", (breakdown) => fallsShort(breakdown));
  eleventyConfig.addFilter("notAttempted", (breakdown) => notAttempted(breakdown));

  // Whether a run predates the metric change, so its page can say so.
  eleventyConfig.addFilter("scoredOnCorrectness", (date) => scoredOnCorrectness(date));
  eleventyConfig.addFilter("findingSource", (finding, repoBase) => sourceUrl(finding, repoBase));

  // Serialise structured data for a <script type="application/ld+json"> block,
  // escaping "<" so a stray "</script>" in any value can't break out of it.
  const jsonLd = (obj) => JSON.stringify(obj).replace(/</g, "\\u003c");

  // Person entity (Martin), mirrored from martinhicks.dev so the two sites
  // share one identity. Same @id reconciles them in a knowledge graph.
  eleventyConfig.addFilter("personJsonLd", (data) => jsonLd(data.site.person));

  // Organization entity (Parity Suite), founder linked to the Person by @id.
  eleventyConfig.addFilter("publisherJsonLd", (data) => jsonLd(data.site.publisher));

  // WebSite entity, injected once per page.
  eleventyConfig.addFilter("websiteJsonLd", (data) =>
    jsonLd({
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": data.site.url + "/#website",
      url: data.site.url,
      name: data.site.title,
      alternateName: data.site.descriptor,
      description: data.site.description,
      inLanguage: "en-GB",
      publisher: { "@id": data.site.url + "/#parity-suite" },
      author: { "@id": "https://martinhicks.dev/#martin-person" },
      license: data.site.license,
    }),
  );

  // WebPage schema for every page, tied into the WebSite, Org and Person graph.
  eleventyConfig.addFilter("webpageJsonLd", (data) =>
    jsonLd({
      "@context": "https://schema.org",
      "@type": "WebPage",
      "@id": data.site.url + data.page.url,
      url: data.site.url + data.page.url,
      name: data.meta?.title || data.site.title,
      description: data.meta?.description || data.site.description,
      inLanguage: "en-GB",
      isPartOf: { "@id": data.site.url + "/#website" },
      publisher: { "@id": data.site.url + "/#parity-suite" },
      author: { "@id": "https://martinhicks.dev/#martin-person" },
    }),
  );

  // Dataset schema for the home page - the conformance results are open data.
  eleventyConfig.addFilter("datasetJsonLd", (data) => {
    const runs = data.conformance?.runs || [];
    const firstRun = runs.length ? runs[runs.length - 1].date : undefined;
    const latestRun = data.conformance?.latest?.date;
    return jsonLd({
      "@context": "https://schema.org",
      "@type": "Dataset",
      "@id": data.site.url + "/#dataset",
      name: "DynamoDB emulator conformance results",
      description:
        "Divergence and coverage per tier and over the whole suite for DynamoDB-compatible emulators, measured against live AWS DynamoDB and recorded run over run.",
      url: data.site.url,
      license: data.site.dataLicense,
      isAccessibleForFree: true,
      creator: { "@id": "https://martinhicks.dev/#martin-person" },
      publisher: { "@id": data.site.url + "/#parity-suite" },
      keywords: ["DynamoDB", "conformance", "emulator", "AWS", "DynamoDB Local", "testing"],
      measurementTechnique: "AWS SDK behavioural tests against each target, baselined on live AWS DynamoDB",
      variableMeasured: [
        "Tier 1 (Core) divergence % and coverage %",
        "Tier 2 (Complete) divergence % and coverage %",
        "Tier 3 (Strict) divergence % and coverage %",
        "Whole-suite divergence % and coverage %",
      ],
      ...(latestRun ? { dateModified: latestRun } : {}),
      ...(firstRun ? { temporalCoverage: `${firstRun}/${latestRun || ".."}` } : {}),
      distribution: [
        {
          "@type": "DataDownload",
          name: "Conformance results (latest run)",
          encodingFormat: "application/json",
          contentUrl: data.site.url + "/data/latest.json",
        },
        {
          "@type": "DataDownload",
          name: "Conformance results (all runs)",
          encodingFormat: "application/json",
          contentUrl: data.site.url + "/data/runs.json",
        },
        {
          "@type": "DataDownload",
          name: "Runs feed",
          encodingFormat: "application/atom+xml",
          contentUrl: data.site.url + "/feed.xml",
        },
      ],
      isBasedOn: data.site.sourceRepo,
    });
  });

  // BreadcrumbList for nested pages (run, target), mirroring the visible trail.
  // Pages provide a `breadcrumbs` array of { name, url }; positions are 1-based.
  eleventyConfig.addFilter("breadcrumbJsonLd", (data) =>
    jsonLd({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: (data.breadcrumbs || []).map((c, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: c.name,
        item: data.site.url + c.url,
      })),
    }),
  );

  // Strip trailing slashes to pair with the CloudFront URL-rewrite function.
  eleventyConfig.addUrlTransform(({ url }) => {
    if (url !== "/") return url.replace(/\/$/, "");
    return url;
  });

  return {
    dir: {
      input: "src",
      output: "_site",
    },
    markdownTemplateEngine: "njk",
  };
}
