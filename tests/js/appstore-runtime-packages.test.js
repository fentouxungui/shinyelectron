// tests/js/appstore-runtime-packages.test.js
//
// The shell's bundled R already provides base/recommended packages. An old app
// bundle could put a KernSmooth built against another R.framework into
// lib/KernSmooth; it then shadows the runtime copy and fails on macOS with
// "Library not loaded: .../libRblas.dylib". Startup must remove those copies
// and stop treating them as app dependencies.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppStore } = require('../../inst/electron/backends/appstore');

function writePackage(dir, name, version, priority) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'DESCRIPTION'), [
    'Package: ' + name,
    'Version: ' + version,
    'Priority: ' + priority,
    ''
  ].join('\n'));
}

test('startup removes legacy runtime packages and keeps other packages', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shinyapps-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const runtimeLibrary = path.join(root, 'runtime', 'R', 'library');
  const dataRoot = path.join(root, 'data');
  const appDir = path.join(dataRoot, 'apps', 'demo', '1.0.0');
  fs.mkdirSync(path.join(appDir, 'app'), { recursive: true });

  // The bundled R provides these two recommended packages.
  writePackage(path.join(runtimeLibrary, 'KernSmooth'), 'KernSmooth', '2.23-26', 'recommended');
  writePackage(path.join(runtimeLibrary, 'MASS'), 'MASS', '7.3-65', 'recommended');

  // A stale shared KernSmooth and a private KernSmooth, both same version.
  writePackage(path.join(dataRoot, 'lib', 'KernSmooth'), 'KernSmooth', '2.23-26', 'recommended');
  writePackage(path.join(dataRoot, 'private', 'demo', 'KernSmooth'), 'KernSmooth', '2.23-26', 'recommended');
  // MASS: shared matches the runtime, private is older and must stay.
  writePackage(path.join(dataRoot, 'lib', 'MASS'), 'MASS', '7.3-65', 'recommended');
  writePackage(path.join(dataRoot, 'private', 'demo', 'MASS'), 'MASS', '7.3-64', 'recommended');
  // An ordinary app package must not be touched.
  writePackage(path.join(dataRoot, 'lib', 'not-runtime'), 'not-runtime', '1.0.0', '');

  fs.writeFileSync(path.join(dataRoot, 'state.json'), JSON.stringify({
    schema: 1,
    apps: {
      demo: {
        version: '1.0.0',
        platform: 'win-x64',
        dir: appDir,
        packages: ['KernSmooth', 'MASS', 'not-runtime'],
        source: 'catalog',
        meta: {}
      }
    },
    shared: {
      KernSmooth: { version: '2.23-26', refs: ['demo'] },
      MASS: { version: '7.3-65', refs: ['demo'] },
      'not-runtime': { version: '1.0.0', refs: ['demo'] }
    }
  }, null, 2));

  const store = createAppStore({
    dataRoot,
    catalogUrl: 'https://example.test/catalog.json',
    runtimeLibrary,
    log: () => {}
  });
  const state = store.getState();

  // KernSmooth is runtime-provided and both stale copies are gone.
  assert.ok(!fs.existsSync(path.join(dataRoot, 'lib', 'KernSmooth')));
  assert.ok(!fs.existsSync(path.join(dataRoot, 'private', 'demo', 'KernSmooth')));
  assert.ok(!state.shared.KernSmooth);
  assert.ok(!state.apps.demo.packages.includes('KernSmooth'));

  // MASS shared copy matches the runtime and is removed; the older private
  // copy stays because it is not the runtime version.
  assert.ok(!fs.existsSync(path.join(dataRoot, 'lib', 'MASS')));
  assert.ok(fs.existsSync(path.join(dataRoot, 'private', 'demo', 'MASS')));
  assert.ok(state.apps.demo.packages.includes('MASS'));

  // Non-runtime packages are untouched.
  assert.ok(fs.existsSync(path.join(dataRoot, 'lib', 'not-runtime')));
  assert.ok(state.apps.demo.packages.includes('not-runtime'));
  assert.ok(state.shared['not-runtime']);
});

test('a runtime package with a different shared version is left alone', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shinyapps-runtime-mismatch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const runtimeLibrary = path.join(root, 'runtime', 'R', 'library');
  const dataRoot = path.join(root, 'data');
  writePackage(path.join(runtimeLibrary, 'KernSmooth'), 'KernSmooth', '2.23-26', 'recommended');
  writePackage(path.join(dataRoot, 'lib', 'KernSmooth'), 'KernSmooth', '2.23-25', 'recommended');
  fs.writeFileSync(path.join(dataRoot, 'state.json'), JSON.stringify({
    schema: 1,
    apps: {},
    shared: { KernSmooth: { version: '2.23-25', refs: [] } }
  }, null, 2));

  const store = createAppStore({
    dataRoot,
    catalogUrl: 'https://example.test/catalog.json',
    runtimeLibrary,
    log: () => {}
  });
  const state = store.getState();
  assert.ok(fs.existsSync(path.join(dataRoot, 'lib', 'KernSmooth')));
  assert.ok(state.shared.KernSmooth);
});
