// Where each engine lives, split into a project site and its source.
//
// The suite carries one URL per target (`repoUrl`, ported in scoring.mjs) and
// it means different things per target: a code repo for most, an AWS product
// or docs page for DynamoDB and DynamoDB Local. Rather than restate those URLs
// here and let the two copies drift, the split is derived - the suite's URL is
// the source when it points at a code host and the project site when it
// doesn't - and only the sites the suite has no room for are listed below.
//
// Values match each repo's own homepage field unless noted. A target with no
// site (dynalite, kumo) and a target with no public source (DynamoDB and
// DynamoDB Local) are both normal.
const WEBSITE = {
  dynoxide: "https://dynoxide.dev",
  localstack: "https://localstack.cloud",
  ministack: "https://ministack.org",
  floci: "https://floci.io/floci/",
  extenddb: "https://extenddb.org/",
  "aws-emulator": "https://docs.aws.amazon.com/emulator/latest/userguide/what-is-service.html",
  // Not the repo's homepage, which is ScyllaDB's site for the whole database.
  alternator: "https://docs.scylladb.com/manual/stable/alternator/alternator.html",
  "phoenix-adapters": "https://phoenix.apache.org/",
};

const CODE_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
  "git.sr.ht",
  "sr.ht",
]);

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// The URL as a reader would say it: no scheme, no www, no trailing slash. Kept
// legible rather than shortened, because the domain is the point - it's how a
// reader tells a project's own site from a page about it.
export function urlLabel(url) {
  if (!url) return null;
  return String(url)
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");
}

// Where a standings row's target link goes. From a run, to that target's results
// for that date; from the homepage's latest table, to its current page.
//
// Two rows keep going to the current page even from a run, because no page is
// built for them on that date and a link would 404: a carried-forward row, where
// nothing was measured, and the baseline, which is never measured at all.
//
// The baseline test keys on `baseline`, the same flag targetRunsOf, matrix and
// capabilities exclude pages by, so "gets a dated page" and "gets a dated link"
// can never disagree. Keying the link on `synthesised` while the pages keyed on
// `baseline` was a latent 404: a target flagged one way but not the other would
// have linked to a page that was never built.
export const targetRunHref = (row, runId) =>
  runId && row?.reTested && !row?.baseline ? `/targets/${row.slug}/${runId}` : `/targets/${row?.slug}`;

export function targetLinks(slug, repoUrl) {
  const isCode = repoUrl ? CODE_HOSTS.has(host(repoUrl)) : false;
  const source = isCode ? repoUrl : null;
  const website = WEBSITE[slug] ?? (repoUrl && !isCode ? repoUrl : null);

  return {
    website: website ? { url: website, label: urlLabel(website) } : null,
    source: source ? { url: source, label: urlLabel(source), host: host(source) } : null,
  };
}
