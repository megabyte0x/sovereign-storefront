import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() ? [relative(root, path).replaceAll('\\', '/')] : [];
    });
}

function buildSourceManifest() {
  const buildInputs = [
    'index.html',
    'checkout.html',
    'package.json',
    'package-lock.json',
    'scripts/clean-build.mjs',
    'tsconfig.json',
    'tsconfig.build.json',
    'vite.config.ts',
    ...sourceFiles(resolve(root, 'src')),
  ].sort();

  return buildInputs.map((path) => ({
    path,
    sha256: sha256(readFileSync(resolve(root, path))),
  }));
}

function manifestDigest(manifest) {
  return sha256(manifest.map(({ path, sha256: digest }) => `${path}\0${digest}\n`).join(''));
}

function captureSourceSnapshot() {
  const sourceManifest = buildSourceManifest();
  return {
    sourceCommit: git(['rev-parse', 'HEAD']),
    dirtyDiffDigest: sha256(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root })),
    sourceManifestDigest: manifestDigest(sourceManifest),
    sourceManifest,
  };
}

function snapshotsMatch(initialSnapshot, finalSnapshot) {
  return initialSnapshot.sourceCommit === finalSnapshot.sourceCommit
    && initialSnapshot.dirtyDiffDigest === finalSnapshot.dirtyDiffDigest
    && initialSnapshot.sourceManifestDigest === finalSnapshot.sourceManifestDigest;
}

function setPublicBuildPermissions(directory) {
  chmodSync(directory, 0o755);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      setPublicBuildPermissions(path);
    } else if (entry.isFile()) {
      chmodSync(path, 0o644);
    } else {
      throw new Error(`unexpected build artifact type: ${relative(root, path)}`);
    }
  }
}

function adapterEntrypoints(manifest) {
  return manifest
    .map(({ path }) => path)
    .filter((path) => path.startsWith('src/adapters/') && path.endsWith('.ts'))
    .map((path) => `dist/service/${path.slice('src/'.length, -'.ts'.length)}.js`);
}

const initialSnapshot = captureSourceSnapshot();

rmSync('dist', { recursive: true, force: true });
run('npm', ['run', 'build:browser']);
run('npm', ['run', 'build:service']);

const finalSnapshot = captureSourceSnapshot();
if (!snapshotsMatch(initialSnapshot, finalSnapshot)) {
  throw new Error('build snapshot changed during build; retry npm run build:clean');
}

const emittedAdapterEntrypoints = adapterEntrypoints(initialSnapshot.sourceManifest);
for (const entrypoint of emittedAdapterEntrypoints) {
  if (!existsSync(resolve(root, entrypoint))) {
    throw new Error(`service adapter entrypoint was not emitted: ${entrypoint}`);
  }
}

const buildInfo = {
  ...initialSnapshot,
  buildTimestamp: new Date().toISOString(),
  adapterEntrypoints: emittedAdapterEntrypoints,
};

writeFileSync('dist/build-info.json', `${JSON.stringify(buildInfo, null, 2)}\n`, 'utf8');
setPublicBuildPermissions(resolve(root, 'dist'));
