// The target registry: who is on the board, how they relate, and how you run
// them.
//
// Lives here rather than in scripts/summarise.mjs because that module's job is
// turning a run into published artefacts, while this is the standing list every
// surface reads - the results table, paritysuite.org, and the per-target pages.
// Adding a target is one edit here and it reaches all of them.
//
// A row on the board is something a reader chooses between, and that is a
// project rather than a build of one: you choose Dynoxide or LocalStack, then
// the build follows from where your code runs. Variants of a project therefore
// nest under it instead of competing beside it, which keeps the board from
// becoming a matrix of build configurations in which whichever project ships
// the most variants occupies the most rows.
//
//   project        groups a variant with its parent
//   reference      the configuration a project treats as canonical, whose
//                  figures the parent row carries
//   configuration  what makes this row distinct, and how a nested row is
//                  labelled
//   distribution   how you actually get and run it (see below)
//
// Declaring the relationship replaces sniffing a bracket out of the display
// name, which is what previously stood in for it.
//
// ── On distribution being asserted rather than measured ─────────────────────
//
// Every figure on the board is derived from a run. This is not: nothing in the
// suite can observe that a project ships a Docker image. So each channel
// carries the page that documents it, and the board links them. A reader
// checks a claim in one click rather than taking it on trust, which is the
// nearest thing to derivation available for a fact of this kind.
//
// Lineage - "this engine is built on that one" - is deliberately NOT declared
// here, though it is tempting. It is measurable: engines sharing an
// implementation fail the same tests, and scripts/lineage.mjs reports that
// similarity from the results themselves. A measured relationship is a claim
// the suite can defend; a typed one is a claim about someone else's product
// that nothing checks.

/** Channel labels, so the board renders a controlled vocabulary. */
export const CHANNELS = {
  service: 'AWS service',
  docker: 'Docker',
  npm: 'npm',
  npx: 'npx',
  pip: 'pip',
  cargo: 'cargo',
  jar: 'JAR',
  maven: 'Maven',
  homebrew: 'Homebrew',
  scoop: 'Scoop',
  'install-script': 'install script',
  binary: 'binary',
  embedded: 'embedded',
  wasm: 'wasm',
  'github-action': 'GitHub Action',
  source: 'source',
}

/**
 * How many channels a board row shows before collapsing the rest behind a
 * link. Projects differ a lot in how many ways they ship - one has nine and
 * one has a single source build - and rendering them all would size a row by
 * its packaging effort rather than by anything the suite measured.
 */
export const CHANNELS_SHOWN = 4

export const TARGETS = {
  dynamodb: {
    display: 'DynamoDB',
    project: 'dynamodb',
    reference: true,
    url: 'https://aws.amazon.com/dynamodb/',
    // The baseline is the hosted service; there is nothing to install.
    distribution: [{ channel: 'service', url: 'https://aws.amazon.com/dynamodb/' }],
  },
  'dynamodb-local': {
    display: 'DynamoDB Local',
    project: 'dynamodb-local',
    reference: true,
    url: 'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html',
    // No `embedded`: a DynamoDBEmbedded class exists in the v3 artefact but AWS
    // documents no such mode, and an undocumented class is not a channel.
    requires: 'JRE 17+ (bundled in the Docker route)',
    distribution: [
      { channel: 'docker', url: 'https://hub.docker.com/r/amazon/dynamodb-local' },
      { channel: 'jar', url: 'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.DownloadingAndRunning.html' },
      { channel: 'maven', url: 'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.DownloadingAndRunning.html' },
    ],
  },
  dynoxide: {
    display: 'Dynoxide',
    project: 'dynoxide',
    reference: true,
    // Named for how the build runs rather than for its storage engine, because
    // that is the axis separating it from the row nested under it: this one is
    // a binary you run, that one is WebAssembly in a browser. A storage name
    // ("native SQLite") paired a storage fact against a runtime fact and the
    // two rows read as answers to different questions. ExtendDB's pair still
    // names storage, because storage is what distinguishes those two.
    configuration: 'self-contained binary',
    url: 'https://github.com/nubo-db/dynoxide',
    requires: 'none - a single binary, with no runtime to install',
    distribution: [
      { channel: 'npx', url: 'https://github.com/nubo-db/dynoxide/blob/main/docs/installation.md' },
      { channel: 'docker', url: 'https://github.com/nubo-db/dynoxide/blob/main/docs/installation.md' },
      { channel: 'homebrew', url: 'https://github.com/nubo-db/homebrew-tap' },
      { channel: 'binary', url: 'https://github.com/nubo-db/dynoxide/releases/latest' },
      { channel: 'npm', url: 'https://www.npmjs.com/package/dynoxide' },
      { channel: 'cargo', url: 'https://crates.io/crates/dynoxide-rs' },
      { channel: 'embedded', url: 'https://github.com/nubo-db/dynoxide/blob/main/docs/library.md' },
      { channel: 'github-action', url: 'https://github.com/nubo-db/dynoxide/blob/main/docs/installation.md' },
      { channel: 'source', url: 'https://github.com/nubo-db/dynoxide' },
    ],
  },
  'dynoxide-wasm': {
    display: 'Dynoxide (wasm)',
    project: 'dynoxide',
    configuration: 'WebAssembly / OPFS',
    url: 'https://github.com/nubo-db/dynoxide',
    requires: 'a browser, on a secure context',
    distribution: [
      { channel: 'npm', url: 'https://www.npmjs.com/package/@dynoxide/wasm-engine' },
      { channel: 'wasm', url: 'https://github.com/nubo-db/dynoxide/blob/main/docs/wasm.md' },
      { channel: 'source', url: 'https://github.com/nubo-db/dynoxide/blob/main/docs/wasm.md' },
    ],
  },
  dynalite: {
    display: 'Dynalite',
    project: 'dynalite',
    reference: true,
    url: 'https://github.com/architect/dynalite',
    requires: 'Node 20+',
    // `npx` is registry metadata (the package declares a bin), not something
    // the project documents, so it is sourced to the registry rather than the
    // readme.
    distribution: [
      { channel: 'npm', url: 'https://github.com/architect/dynalite/blob/main/readme.md' },
      { channel: 'npx', url: 'https://www.npmjs.com/package/dynalite' },
      { channel: 'embedded', url: 'https://github.com/architect/dynalite/blob/main/readme.md' },
    ],
  },
  localstack: {
    display: 'LocalStack',
    project: 'localstack',
    reference: true,
    url: 'https://github.com/localstack/localstack',
    requires: 'Docker, and an auth token since March 2026',
    note:
      'The Community image was sunset in March 2026; the unified image needs a ' +
      'LOCALSTACK_AUTH_TOKEN, so an account is now part of running it.',
    distribution: [
      { channel: 'docker', url: 'https://hub.docker.com/r/localstack/localstack' },
      { channel: 'pip', url: 'https://pypi.org/project/localstack/' },
      { channel: 'homebrew', url: 'https://github.com/localstack/localstack#installation' },
      { channel: 'binary', url: 'https://github.com/localstack/localstack-cli/releases/latest' },
    ],
  },
  ministack: {
    display: 'Ministack',
    project: 'ministack',
    reference: true,
    url: 'https://github.com/ministackorg/ministack',
    requires: 'Python 3.10+ for the pip route; DynamoDB runs in-process, so no Docker',
    distribution: [
      { channel: 'pip', url: 'https://pypi.org/project/ministack/' },
      { channel: 'docker', url: 'https://hub.docker.com/r/ministackorg/ministack' },
      { channel: 'source', url: 'https://github.com/ministackorg/ministack' },
    ],
  },
  floci: {
    display: 'Floci',
    project: 'floci',
    reference: true,
    url: 'https://github.com/floci-io/floci',
    requires: 'Docker',
    // The emulator itself ships only as an image - every GitHub release has
    // zero assets. The other channels install floci-cli, which pulls and runs
    // that image, so they are how you launch it rather than another way to get
    // it. Said plainly here rather than implied by listing them side by side.
    note:
      'Only the Docker image is the emulator. The other channels install the ' +
      'floci CLI, which pulls and runs that image for you.',
    distribution: [
      { channel: 'docker', url: 'https://hub.docker.com/r/floci/floci' },
      { channel: 'homebrew', url: 'https://github.com/floci-io/floci-cli' },
      { channel: 'install-script', url: 'https://github.com/floci-io/floci-cli' },
      { channel: 'scoop', url: 'https://github.com/floci-io/scoop-floci' },
      { channel: 'binary', url: 'https://github.com/floci-io/floci-cli/releases/latest' },
      { channel: 'jar', url: 'https://github.com/floci-io/floci-cli' },
    ],
  },
  kumo: {
    display: 'Kumo',
    project: 'kumo',
    reference: true,
    url: 'https://github.com/sivchari/kumo',
    requires: 'none - a single Go binary, or Docker for the image',
    distribution: [
      { channel: 'docker', url: 'https://github.com/sivchari/kumo/pkgs/container/kumo' },
      { channel: 'binary', url: 'https://github.com/sivchari/kumo/releases/latest' },
      { channel: 'source', url: 'https://github.com/sivchari/kumo' },
    ],
  },
  // ExtendDB's storage backend is pluggable, chosen at build time by Cargo
  // feature, and exactly one is compiled into a given binary. A backend is
  // therefore a different engine under one wire protocol, which is a variant of
  // this project rather than a row of its own. PostgreSQL is the reference
  // backend and carries the parent row; SQLite shipped in v0.1.3 and nests
  // below it. MongoDB is merged to main but is in no release, so it is not here.
  extenddb: {
    display: 'ExtendDB',
    project: 'extenddb',
    reference: true,
    configuration: 'PostgreSQL',
    url: 'https://github.com/ExtendDB/extenddb',
    requires: 'PostgreSQL 14+, and a Rust toolchain to build it',
    // Source only, checked rather than assumed: every release has zero assets,
    // the crate is not on crates.io, and while a Dockerfile and a Docker Hub
    // repository now exist, the only tags published there are commit-addressed
    // build candidates - no version tag and no `latest`. The install scripts
    // build from source; they do not fetch a binary. Revisit when the promotion
    // job lands: `curl -s https://hub.docker.com/v2/repositories/extenddb/
    // extenddb-postgres/tags/latest` returning 200 is the check.
    note:
      'An adapter over an external PostgreSQL rather than a self-contained ' +
      'store. TLS and SigV4 are mandatory, and it listens on 18443.',
    distribution: [
      { channel: 'source', url: 'https://github.com/ExtendDB/extenddb' },
    ],
  },
  'extenddb-sqlite': {
    display: 'ExtendDB (SQLite)',
    project: 'extenddb',
    configuration: 'SQLite',
    url: 'https://github.com/ExtendDB/extenddb',
    requires: 'a Rust toolchain to build it, and no external database',
    // The same server, wire protocol and auth stack as the parent row, over a
    // single SQLite file. Built WITHOUT the `dev-mode` feature: dev-mode serves
    // plain HTTP with open authorisation, which is a different security posture
    // and so not the same thing to measure. Holding that fixed leaves the
    // storage engine as the only variable between these two rows.
    note:
      'The PostgreSQL build\'s server over a single SQLite file rather than ' +
      'an external database. TLS and SigV4 stay mandatory.',
    distribution: [
      {
        channel: 'source',
        url: 'https://github.com/ExtendDB/extenddb/blob/main/crates/storage-sqlite/README.md',
      },
    ],
  },
}

/** Display names, derived. The site renders the same targets. */
export const DISPLAY = Object.fromEntries(
  Object.entries(TARGETS).map(([slug, t]) => [slug, t.display]),
)
export const display = (slug) => DISPLAY[slug] ?? slug.replace(/-/g, ' ')

/** Project home for each target, linked from its name in the table. */
export const REPO = Object.fromEntries(
  Object.entries(TARGETS).map(([slug, t]) => [slug, t.url]),
)
export const repoUrl = (slug) => REPO[slug] ?? null
export const label = (slug) =>
  REPO[slug] ? `[${display(slug)}](${REPO[slug]})` : display(slug)

/** The project a target belongs to; its own slug when it declares none. */
export const projectOf = (slug) => TARGETS[slug]?.project ?? slug

/** Whether a target is a non-reference configuration of some project. */
export const isVariant = (slug) => Boolean(TARGETS[slug] && !TARGETS[slug].reference)

/** What distinguishes this configuration, for a nested row's label. */
export const configurationOf = (slug) => TARGETS[slug]?.configuration ?? null

/**
 * How a target is distributed: `[{ channel, label, url, command? }]`, in
 * declaration order. Empty when nothing has been verified, which renders as
 * nothing rather than as a guess.
 */
export const distributionOf = (slug) =>
  (TARGETS[slug]?.distribution ?? []).map((d) => ({
    ...d,
    label: CHANNELS[d.channel] ?? d.channel,
  }))
