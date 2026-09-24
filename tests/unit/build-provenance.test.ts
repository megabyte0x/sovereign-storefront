import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';

const root = process.cwd();
const buildInputPaths = [
  'index.html',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'vite.config.ts',
  'src',
  'scripts/clean-build.mjs',
];

type ManifestEntry = { path: string; sha256: string };
type BuildInfo = {
  sourceCommit: string;
  sourceManifest: ManifestEntry[];
  sourceManifestDigest: string;
  dirtyDiffDigest: string;
  buildTimestamp: string;
  adapterEntrypoints: string[];
};

type ProcessFailure = Error & { stderr?: Buffer };

function sha256(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

function sourceFiles(repository: string, directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(repository, path);
      return entry.isFile() ? [relative(repository, path).replaceAll('\\', '/')] : [];
    });
}

function sourceManifest(repository: string): ManifestEntry[] {
  return [
    ...buildInputPaths.filter((path) => path !== 'src'),
    ...sourceFiles(repository, resolve(repository, 'src')),
  ]
    .sort()
    .map((path) => ({ path, sha256: sha256(readFileSync(resolve(repository, path))) }));
}

function manifestDigest(manifest: ManifestEntry[]): string {
  return sha256(manifest.map(({ path, sha256: digest }) => `${path}\0${digest}\n`).join(''));
}

function createRepository(browserBuildCommand?: string): { scratchDirectory: string; repository: string } {
  const scratchDirectory = mkdtempSync(join(tmpdir(), 'build-provenance-'));
  const repository = resolve(scratchDirectory, 'repository');
  mkdirSync(repository);

  for (const path of buildInputPaths) {
    const source = resolve(root, path);
    const destination = resolve(repository, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
  symlinkSync(resolve(root, 'node_modules'), resolve(repository, 'node_modules'), 'dir');

  if (browserBuildCommand) {
    const packageJson = JSON.parse(readFileSync(resolve(repository, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    packageJson.scripts['build:browser'] = browserBuildCommand;
    writeFileSync(resolve(repository, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  }

  writeFileSync(resolve(repository, 'snapshot-probe.txt'), 'initial\n');
  execFileSync('git', ['init', '--quiet'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'build-provenance@example.test'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Build Provenance Test'], { cwd: repository });
  execFileSync('git', ['add', '--all'], { cwd: repository });
  execFileSync('git', ['commit', '--quiet', '-m', 'test snapshot'], { cwd: repository });

  return { scratchDirectory, repository };
}

function runCleanBuild(repository: string): void {
  execFileSync('npm', ['run', 'build:clean'], { cwd: repository, stdio: 'pipe' });
}

test('clean build removes stale adapters and records source-linked provenance in a disposable repository', () => {
  const { scratchDirectory, repository } = createRepository();
  const staleAdapterPaths = [
    'dist/service/adapters/orphan-probe.js',
    'dist/service/adapters/live.js',
    'dist/service/adapters/zakura-scanner.js',
  ];
  const sourceMarker = `build-provenance-marker-${randomUUID()}`;

  try {
    const mainPath = resolve(repository, 'src/main.ts');
    writeFileSync(mainPath, `${readFileSync(mainPath, 'utf8')}\nconsole.log(${JSON.stringify(sourceMarker)});\n`);
    for (const staleAdapterPath of staleAdapterPaths) {
      const path = resolve(repository, staleAdapterPath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'export const stale = true;\n');
    }

    runCleanBuild(repository);

    for (const staleAdapterPath of staleAdapterPaths) {
      expect(existsSync(resolve(repository, staleAdapterPath))).toBe(false);
    }

    const buildInfo = JSON.parse(readFileSync(resolve(repository, 'dist/build-info.json'), 'utf8')) as BuildInfo;
    expect(buildInfo.sourceCommit)
      .toBe(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: repository }).trim());
    expect(buildInfo.sourceManifest).toEqual(sourceManifest(repository));
    expect(buildInfo.sourceManifestDigest).toBe(manifestDigest(buildInfo.sourceManifest));
    expect(buildInfo.dirtyDiffDigest).toBe(
      sha256(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: repository })),
    );
    expect(Number.isNaN(Date.parse(buildInfo.buildTimestamp))).toBe(false);
    expect(readFileSync(resolve(repository, 'src/main.ts'), 'utf8')).toContain(sourceMarker);
    expect(buildInfo.sourceManifest).toContainEqual({
      path: 'src/main.ts',
      sha256: sha256(readFileSync(resolve(repository, 'src/main.ts'))),
    });
    expect(readFileSync(resolve(repository, 'dist/service/main.js'), 'utf8')).toContain(sourceMarker);
    expect(buildInfo.adapterEntrypoints).toContain('dist/service/adapters/scanner.js');
    expect(buildInfo.adapterEntrypoints.length).toBeGreaterThan(0);
    for (const adapterEntrypoint of buildInfo.adapterEntrypoints) {
      expect(existsSync(resolve(repository, adapterEntrypoint))).toBe(true);
    }
  } finally {
    rmSync(scratchDirectory, { recursive: true, force: true });
  }
});

test('clean build refuses to write provenance when the repository snapshot changes during the build', () => {
  const mutationCommand = [
    'node --input-type=module -e',
    `"import { appendFileSync } from 'node:fs'; import { execFileSync } from 'node:child_process'; appendFileSync('snapshot-probe.txt', '\\nchanged\\n'); execFileSync('git', ['commit', '--allow-empty', '--quiet', '-m', 'build snapshot mutation']);"`,
  ].join(' ');
  const { scratchDirectory, repository } = createRepository(mutationCommand);

  try {
    let failure: ProcessFailure | undefined;
    try {
      runCleanBuild(repository);
    } catch (error) {
      failure = error as ProcessFailure;
    }

    expect(failure).toBeDefined();
    expect(failure?.stderr?.toString()).toContain('build snapshot changed during build');
    expect(existsSync(resolve(repository, 'dist/build-info.json'))).toBe(false);
  } finally {
    rmSync(scratchDirectory, { recursive: true, force: true });
  }
});
