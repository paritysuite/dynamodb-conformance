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
//   licence        the terms it is offered under (see below)
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
//
// ── On licence ───────────────────────────────────────────────────────────────
//
// Asserted too, and handled the same way: `{ name, spdx?, url }`, where `name`
// is what a reader sees, `spdx` is present only when the licence has a real
// SPDX identifier or expression, and `url` is the licence text or the
// vendor's terms. It is read from the project's own licence file (or, where
// the thing the suite runs is licensed differently from the repository, from
// that) and named, never characterised: every target shows the same field in
// the same place, with no "open source" or "not open source" beside it. It
// sits on the project's reference entry and the other builds inherit it
// through licenceOf, so a build declares one only when its licence really
// differs.

/**
 * Channel labels, so the board renders a controlled vocabulary.
 *
 * `package` is software the operating system's package manager installs: apt
 * or dnf, from a repository or from a .deb or .rpm. A package manager with a
 * channel of its own here (npm, pip, cargo, Maven, Homebrew, Scoop) uses that
 * channel instead.
 */
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
  package: 'OS package',
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
    licence: { name: 'AWS Customer Agreement', url: 'https://aws.amazon.com/agreement/' },
    // The baseline is the hosted service; there is nothing to install.
    distribution: [{ channel: 'service', url: 'https://aws.amazon.com/dynamodb/' }],
  },
  'dynamodb-local': {
    display: 'DynamoDB Local',
    project: 'dynamodb-local',
    reference: true,
    url: 'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html',
    licence: { name: 'Amazon DynamoDB Local License Agreement', url: 'https://aws.amazon.com/dynamodb/dynamodblocallicense/' },
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
    // two rows read as answers to different questions. ExtendDB's builds still
    // name storage, because storage is what distinguishes them.
    configuration: 'self-contained binary',
    url: 'https://github.com/nubo-db/dynoxide',
    licence: { name: 'MIT OR Apache-2.0', spdx: 'MIT OR Apache-2.0', url: 'https://github.com/nubo-db/dynoxide/blob/main/README.md#license' },
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
    licence: { name: 'Apache-2.0', spdx: 'Apache-2.0', url: 'https://github.com/architect/dynalite/blob/main/LICENSE' },
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
  // ScyllaDB's own DynamoDB-compatible API, served by the database node rather
  // than a separate emulator, so the channels are ScyllaDB's. A write-isolation
  // mode must be chosen at start-up and has no default. The modes differ only
  // under concurrent writers to one item, or by refusing conditional writes
  // outright, and the suite drives one client serially, so the mode is a
  // start-up flag rather than a configuration with rows of its own.
  alternator: {
    display: 'Alternator',
    project: 'alternator',
    reference: true,
    url: 'https://github.com/scylladb/scylladb',
    licence: { name: 'ScyllaDB Software License Agreement', url: 'https://github.com/scylladb/scylladb/blob/master/LICENSE-ScyllaDB-Source-Available.md' },
    requires: 'Docker or a Linux install; a write-isolation mode must be chosen, there is no default',
    note:
      'ScyllaDB\'s DynamoDB-compatible API, served by the database node rather ' +
      'than a standalone emulator. Run with --alternator-write-isolation=' +
      'only_rmw_uses_lwt.',
    distribution: [
      { channel: 'docker', url: 'https://hub.docker.com/r/scylladb/scylla' },
      {
        channel: 'package',
        url: 'https://docs.scylladb.com/manual/stable/getting-started/install-scylla/install-on-linux.html',
      },
      {
        channel: 'install-script',
        url: 'https://docs.scylladb.com/manual/stable/getting-started/installation-common/scylla-web-installer.html',
      },
      {
        channel: 'binary',
        url: 'https://docs.scylladb.com/manual/stable/getting-started/installation-common/unified-installer.html',
      },
      { channel: 'source', url: 'https://github.com/scylladb/scylladb' },
    ],
  },
  localstack: {
    display: 'LocalStack',
    project: 'localstack',
    reference: true,
    // The project site rather than the GitHub repository: the repository is
    // archived, and its licence file is not the one the measured image is
    // offered under, so linking it as the source beside the licence below
    // would pair two things that do not belong together.
    url: 'https://www.localstack.cloud',
    // The image the suite runs ships no LocalStack licence file. Its
    // localstack-core, localstack-pro-core and localstack-pro-apps packages
    // each declare `LicenseRef-All-Rights-Reserved`. LocalStack's Terms of
    // Service are the terms the image is offered under without a
    // subscription; subscribers are under its Master Services Agreement.
    licence: { name: 'LocalStack Terms of Service', url: 'https://www.localstack.cloud/legal/terms-of-service' },
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
    licence: { name: 'MIT', spdx: 'MIT', url: 'https://github.com/ministackorg/ministack/blob/main/LICENSE' },
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
    licence: { name: 'MIT', spdx: 'MIT', url: 'https://github.com/floci-io/floci/blob/main/LICENSE' },
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
      { channel: 'binary', url: 'https://github.com/floci-io/floci-cli/releases/latest' },
      { channel: 'jar', url: 'https://github.com/floci-io/floci-cli' },
    ],
  },
  // Source only, checked rather than assumed: no release, no tag, no artefact
  // on Maven Central and no published image. The project's own Docker setup
  // builds the REST server and an HBase-with-Phoenix image locally and runs
  // them beside upstream ZooKeeper and Hadoop images, so the source link is
  // also where that setup is documented. Revisit when a release is cut:
  // `gh api repos/apache/phoenix-adapters/releases --jq length` going above 0
  // is the check.
  'phoenix-adapters': {
    display: 'Phoenix-Adapters',
    project: 'phoenix-adapters',
    reference: true,
    url: 'https://github.com/apache/phoenix-adapters',
    licence: { name: 'Apache-2.0', spdx: 'Apache-2.0', url: 'https://github.com/apache/phoenix-adapters/blob/main/LICENSE' },
    requires: 'Docker, and a from-source build; the stack is six containers',
    note:
      'A DynamoDB-compatible REST layer over Apache Phoenix on HBase rather ' +
      'than a self-contained store. No release is published, so the row ' +
      'measures a commit of main.',
    distribution: [
      { channel: 'source', url: 'https://github.com/apache/phoenix-adapters' },
    ],
  },
  kumo: {
    display: 'Kumo',
    project: 'kumo',
    reference: true,
    url: 'https://github.com/sivchari/kumo',
    licence: { name: 'MIT', spdx: 'MIT', url: 'https://github.com/sivchari/kumo/blob/main/LICENSE' },
    requires: 'none - a single Go binary, or Docker for the image',
    distribution: [
      { channel: 'docker', url: 'https://github.com/sivchari/kumo/pkgs/container/kumo' },
      { channel: 'binary', url: 'https://github.com/sivchari/kumo/releases/latest' },
      { channel: 'source', url: 'https://github.com/sivchari/kumo' },
    ],
  },
  // A multi-service emulator, of which DynamoDB and DynamoDB Streams are two
  // services. It runs natively only on Linux, from an RPM or Debian package.
  // No image is published: the Docker route builds one from the Dockerfile in
  // its user guide, which installs the same package, so the channel is sourced
  // to that page rather than to a registry. Its own security defaults stay on
  // when measured (HTTPS with a per-run certificate, SigV4 with a per-run key),
  // as ExtendDB's do.
  'aws-emulator': {
    display: 'AWS Emulator',
    project: 'aws-emulator',
    reference: true,
    url: 'https://github.com/aws/aws-emulator',
    // The project's readme states both: CC0-1.0, except the vendor/ directory,
    // which is Apache-2.0 and compiled into the same binary.
    licence: { name: 'CC0-1.0 AND Apache-2.0', spdx: 'CC0-1.0 AND Apache-2.0', url: 'https://github.com/aws/aws-emulator/blob/main/README.md#license' },
    requires: 'Linux for the native package; elsewhere Docker, with an image you build',
    note:
      'DynamoDB is one of the many AWS services it serves. No image is ' +
      'published; the Docker route builds one from a Dockerfile in its user ' +
      'guide. HTTPS and SigV4 are on by default, and it listens on 9297.',
    distribution: [
      { channel: 'package', url: 'https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-linux.html' },
      { channel: 'docker', url: 'https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-docker.html' },
      { channel: 'embedded', url: 'https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-embedded.html' },
      { channel: 'source', url: 'https://github.com/aws/aws-emulator' },
    ],
  },
  // ExtendDB's storage backend is pluggable, chosen at build time by Cargo
  // feature, and exactly one is compiled into a given binary. A backend is
  // therefore a different engine under one wire protocol, which is a variant of
  // this project rather than a row of its own. PostgreSQL is the reference
  // backend and carries the parent row; SQLite (from v0.1.3) and MongoDB (from
  // v0.1.5) nest below it.
  extenddb: {
    display: 'ExtendDB',
    project: 'extenddb',
    reference: true,
    configuration: 'PostgreSQL',
    url: 'https://github.com/ExtendDB/extenddb',
    licence: { name: 'Apache-2.0', spdx: 'Apache-2.0', url: 'https://github.com/ExtendDB/extenddb/blob/main/LICENSE' },
    requires: 'PostgreSQL 14+, and Docker for the image or a Rust toolchain to build it',
    // Docker is the official extenddb-postgres image. Its npm binaries are
    // dev-mode builds and no other binary is published, so the other route is a source build, which is how the suite runs it, at
    // the release tag.
    note:
      'An adapter over an external PostgreSQL rather than a self-contained ' +
      'store. TLS and SigV4 are mandatory, and it listens on 18443.',
    distribution: [
      { channel: 'docker', url: 'https://hub.docker.com/r/extenddb/extenddb-postgres' },
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
    // storage engine as the only variable between these rows.
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
  'extenddb-mongodb': {
    display: 'ExtendDB (MongoDB)',
    project: 'extenddb',
    configuration: 'MongoDB',
    url: 'https://github.com/ExtendDB/extenddb',
    requires: 'a MongoDB 7.0+ replica set, and Docker for the image or a Rust toolchain to build it',
    // The same server, wire protocol and auth stack as the parent row, over an
    // external MongoDB, which has to run as a replica set (one node is enough)
    // because the backend writes through multi-document transactions. Built
    // without `dev-mode`, as the SQLite row is.
    //
    // Docker is the official extenddb-mongodb image. Its npm binaries are
    // dev-mode builds and no other binary is published, so the other route is a source build, which is how the suite runs it, at
    // the release tag.
    note:
      'The PostgreSQL build\'s server over an external MongoDB replica set ' +
      'rather than PostgreSQL. TLS and SigV4 stay mandatory.',
    distribution: [
      { channel: 'docker', url: 'https://hub.docker.com/r/extenddb/extenddb-mongodb' },
      {
        channel: 'source',
        url: 'https://github.com/ExtendDB/extenddb/blob/main/docs/local-mongodb-setup.md',
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
 * The configuration a project's own row names beside the project, or null.
 *
 * The parent row names its configuration, so a reader can tell which build the
 * top row's figures belong to the moment a project ships a second. A build
 * promoted to stand for its project already carries its configuration in the
 * display name the registry gives it, so naming it again would read
 * "ExtendDB (SQLite) · SQLite". The README table and the site's standings both
 * name a row through this, so the two cannot disagree about which rows do.
 */
export const rowConfigurationOf = (slug) =>
  isVariant(slug) ? null : configurationOf(slug)

/** A project row's name: `name`, then its configuration when it names one. */
export const rowName = (slug, name = display(slug)) => {
  const configuration = rowConfigurationOf(slug)
  return configuration ? `${name} · ${configuration}` : name
}

/**
 * The licence a target is offered under: `{ name, spdx?, url }`, or null for an
 * unregistered slug. A build with none of its own inherits its project's, from
 * the project's reference entry, so the builds of one project cannot drift
 * apart by being copied.
 */
export const licenceOf = (slug) => {
  const target = TARGETS[slug]
  if (!target) return null
  if (target.licence) return target.licence
  const reference = Object.entries(TARGETS).find(
    ([s, t]) => t.reference && projectOf(s) === projectOf(slug),
  )
  return reference?.[1].licence ?? null
}

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
