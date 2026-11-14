// Reading a target's licence back off a built page, for check-build.
//
// The licence is rendered by one component (licence-link.webc) on the target
// page and in the directory, and marked with `data-licence` on the link and
// `data-licence-name` on its visible text. Reading the marked link, rather than
// searching the page for the licence's name, means a name printed anywhere
// else on the page cannot stand in for the link a reader is meant to follow.

const decode = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** The first marked licence link in `html`, as `{ name, url }`, or null. */
export function licenceLinkIn(html) {
  const link = /<a\b([^>]*\bdata-licence\b[^>]*)>([\s\S]*?)<\/a>/.exec(html ?? "");
  if (!link) return null;
  const href = /\bhref="([^"]*)"/.exec(link[1])?.[1];
  const name = /\bdata-licence-name\b[^>]*>([^<]*)</.exec(link[2])?.[1];
  return {
    name: name == null ? null : decode(name).trim(),
    url: href == null ? null : decode(href),
  };
}

/**
 * What sits on the licence line besides its label and the marked link, as
 * markup, or "" when there is nothing. The line is the paragraph holding the
 * link; inside the link, only the name and the screen-reader text belong. A
 * classification, an icon or a glyph beside either would be the one thing on
 * the line that ranks licences, so anything left over is reported. Null when
 * there is no marked link in a paragraph at all.
 */
export function licenceLineExtras(html) {
  const source = html ?? "";
  const link = /<a\b[^>]*\bdata-licence\b[^>]*>([\s\S]*?)<\/a>/.exec(source);
  if (!link) return null;
  const start = source.lastIndexOf("<p", link.index);
  const end = source.indexOf("</p>", link.index + link[0].length);
  if (start < 0 || end < 0) return null;
  const inner = source.slice(source.indexOf(">", start) + 1, end);
  const outside = inner
    .replace(link[0], "")
    .replace(/<span\b[^>]*>Licence:<\/span>|Licence:/, "")
    .trim();
  const insideLink = link[1]
    .replace(/<span\b[^>]*\bdata-licence-name\b[^>]*>[^<]*<\/span>/, "")
    .replace(/<span\b[^>]*\bclass="sr-only"[^>]*>[^<]*<\/span>/, "")
    .trim();
  return [outside, insideLink].filter(Boolean).join(" ");
}

/** Whether a rendered licence link names and links exactly the published one. */
export const sameLicence = (shown, published) =>
  Boolean(shown && published && shown.name === published.name && shown.url === published.url);

/**
 * The pages whose licence link disagrees with the published licence. `pages`
 * is `[{ slug, html }]`; `published` maps a slug to its endpoint `licence`.
 * One line per disagreement, saying what was shown and what was expected.
 */
export function licenceGaps(pages, published) {
  const gaps = [];
  for (const { slug, html } of pages) {
    const shown = licenceLinkIn(html);
    const expected = published(slug);
    const said = (l) => (l ? `"${l.name}" -> ${l.url}` : "none");
    if (!sameLicence(shown, expected)) {
      gaps.push(`${slug}: shows ${said(shown)}, endpoint has ${said(expected)}`);
      continue;
    }
    const extras = licenceLineExtras(html);
    if (extras === null) gaps.push(`${slug}: the licence link is not on a line of its own`);
    else if (extras) gaps.push(`${slug}: the licence line carries more than its label and link: ${extras.slice(0, 80)}`);
  }
  return gaps;
}

/** A directory page split into its project entries, as `[{ slug, html }]`. */
export const directoryEntriesIn = (html) =>
  [...(html ?? "").matchAll(/<article\b[^>]*\bid="project-([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/article>/g)].map(
    ([, slug, body]) => ({ slug, html: body }),
  );
