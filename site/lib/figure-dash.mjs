// A dash standing in for a figure in a sentence. A row with no divergence or
// coverage printed "-" for each, and every sentence built around one read
// "answers - of the suite" or "diverges on -, covers -". A dash in a table
// cell is a figure's place and stays; a dash in a sentence is a figure
// missing.
//
// Three shapes:
//   - a figure verb whose object is a dash, where the dash ends the clause,
//     comes before a separator ("covers - · capped"), a figure phrase
//     ("diverges on - of it", "up to - in the other 5") or the start of the
//     next sentence or heading ("covers - How to run it");
//   - a dash as the subject of a figure phrase ("- of the suite", "- covered",
//     "- diverges");
//   - a run of dashes standing in for a run of figures ("- / - / -").
//
// A dash used as a pause in prose ("implements - and these") continues in
// lower case with no figure phrase after it, and matches none of these. Nor
// does a dash inside a test's title ("BatchGetItem - exact error messages"),
// which has no figure verb before it; a title that did put one there would be
// reported, and would need its own exemption.

const DASH = "[-–]";
const VERB = String.raw`\b(?:answers|diverges on|covers|implements|up to)`;
const AFTER = String.raw`(?=\s*(?:$|[,.;:)·]|[A-Z]|of\b|in the other\b))`;

export const FIGURE_DASH = new RegExp(
  [
    String.raw`${VERB}\s+${DASH}${AFTER}`,
    String.raw`(?:^|[\s(])${DASH}\s+(?:of the suite|covered\b|diverges\b)`,
    String.raw`(?:^|[\s(])${DASH}\s*/\s*${DASH}(?=\s|$|/)`,
  ].join("|"),
);

// The first match in a piece of text, with a little context, or null.
export function figureDashIn(text) {
  const m = FIGURE_DASH.exec(text);
  return m ? text.slice(Math.max(0, m.index - 40), m.index + 40) : null;
}
