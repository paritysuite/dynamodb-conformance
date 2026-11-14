import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { capClauseOf, display, gradeForRow, isVariant, projectOf, regionalClauseForRow } from "../lib/scoring.mjs";
import { notScoredStatement } from "../lib/unanswered.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Strip a leading YAML front-matter block, leaving just the page body.
function body(md) {
  const m = md.match(/^---\n[\s\S]*?\n---\n?/);
  return (m ? md.slice(m[0].length) : md).trim();
}

// Pull a hand-authored prose page's body, absolutising its root-relative links
// so the corpus stands alone when read away from the site.
//
// The body goes through the template engine first. These pages carry the same
// interpolations the HTML build resolves - the grading criteria version, its
// effective date, the coverage-weighting sentence - and reading them straight
// off disk shipped the raw `{{ ... }}` source instead. This corpus is the one
// surface an agent reading text rather than JSON gets the criteria from, so it
// was the one place they were unreadable.
async function page(render, file, siteUrl, data) {
  const raw = readFileSync(join(HERE, file), "utf8");
  const rendered = await render(body(raw), "njk", data);
  return rendered.trim().replace(/\]\(\//g, `](${siteUrl}/`);
}

// The latest standings rendered as plain text, derived from the same model the
// tables use, so this corpus can never drift from the live figures.
function latestResults(conformance) {
  const latest = conformance?.latest;
  if (!latest) return "";
  const lines = latest.standings.map((r) => {
    const t = r.tiers || {};
    const tiers = `Tier 1 ${t.tier1?.divergence ?? "-"}, Tier 2 ${t.tier2?.divergence ?? "-"}, Tier 3 ${t.tier3?.divergence ?? "-"}`;
    const isBaseline = r.slug === "dynamodb";
    const baseline = isBaseline ? " (baseline)" : "";
    // The yardstick carries no letter here either, or this corpus would be the
    // one surface telling an agent real DynamoDB scored A+ against itself.
    const grade = gradeForRow(r);
    // The same clause the pages render, from the same helper, so the corpus an
    // agent reads cannot phrase a cap differently from the board a human reads.
    const clause = capClauseOf(r);
    const cap = clause ? ` (${clause})` : "";
    // And where the letter does not hold in every region, the same note.
    const regional = regionalClauseForRow(r);
    const regionalNote = regional ? ` (${regional})` : "";
    // This list is flat, so a build of a project reads as a rival to it unless
    // it says otherwise. The board has the indent to carry that; here it has to
    // be words, or two builds of one engine print as two unrelated entries with
    // near-identical figures.
    //
    // Relatedness comes from the registry, which is always available, and only
    // the closed-state clause depends on the run. A model restored from the committed
    // fallback predates the flag, so keying the whole sentence on it would have
    // dropped the relationship entirely on exactly the builds most likely to
    // look like duplicates.
    const build = isVariant(r.slug) ? `, a build of ${display(projectOf(r.slug))}` : "";
    // No disclosure in plain text, so every build is simply listed with its own
    // figures. The note says what the board does with it, which is the only
    // thing a reader of this file cannot see for themselves - named to the three
    // figures the board compared, because it compares no others.
    const closed = r.collapsed ? " (shown closed on the board: same grade, divergence and coverage as the build above)" : "";
    // A row not scored because tests got no answer has no figure for the
    // clauses below, so it says what its page says instead.
    const pt = conformance.perTarget?.[r.slug];
    const statement = notScoredStatement(r, { runUnanswered: pt?.runUnanswered, records: pt?.unanswered });
    if (statement) return `- ${r.display}${build}${closed} - ${statement.text} Version ${r.version}.`;
    return `- ${r.display}${baseline}${build}${closed} - grade ${grade.letter ?? grade.qualifier}${cap}${regionalNote}; diverges ${r.divergence} of the suite; covers ${r.coverage}; diverges per tier ${tiers}; version ${r.version}`;
  });
  return [
    `# Latest results`,
    "",
    `Run ${latest.id} (${latest.date}), ${latest.suiteSize} tests. Divergence is failed / total and coverage is implemented / total, over the whole suite and again within each tier; lower divergence is better and the two are never added together. The grade is a reading of the pair: divergence sets the letter and coverage can only lower it, never raise it, by adding a third of whatever is unimplemented to the divergence before the bands are read. Rank on the two figures rather than the letter: withdrawing a failing test still moves the effective figure down by two thirds of what left. DynamoDB is the baseline, diverging nowhere by definition.`,
    "",
    ...lines,
  ].join("\n");
}

export default class {
  data() {
    return { permalink: "/llms-full.txt", eleventyExcludeFromCollections: true };
  }

  async render(data) {
    const { site, conformance } = data;
    const render = this.renderTemplate.bind(this);
    const header = [
      `# Parity Suite`,
      "",
      `> ${site.description}`,
      "",
      `This file concatenates the About and Methodology pages, the agent guide, and the latest results as text, so the whole picture can be read in one fetch. It's regenerated at build time from the same results as the rest of the site, so it can't drift from the live figures. Data endpoints and the licence are listed at the end.`,
    ].join("\n");

    const data_footer = [
      `# Data`,
      "",
      `- Latest run (JSON): ${site.url}/data/latest.json`,
      `- All runs (JSON): ${site.url}/data/runs.json`,
      `- Data index (JSON): ${site.url}/data/index.json`,
      `- Runs feed (Atom): ${site.url}/feed.xml`,
      "",
      `Published under CC BY 4.0; credit ${site.dataAttribution}.`,
    ].join("\n");

    return [
      header,
      await page(render, "about.md", site.url, data),
      await page(render, "methodology.md", site.url, data),
      await page(render, "for-agents.md", site.url, data),
      latestResults(conformance),
      data_footer,
    ].join("\n\n---\n\n") + "\n";
  }
}
