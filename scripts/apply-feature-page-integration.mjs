#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

const BUILD = new URL('../scripts/build.mjs', import.meta.url);
const WORKFLOW = new URL('../.github/workflows/publish.yml', import.meta.url);

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  const last = text.lastIndexOf(before);
  if (first === -1) throw new Error(`${label}: anker ontbreekt`);
  if (first !== last) throw new Error(`${label}: anker komt meer dan één keer voor`);
  return text.slice(0, first) + after + text.slice(first + before.length);
}

let build = await readFile(BUILD, 'utf8');
if (!build.includes("writeFile(join(outDir, 'features.html')")) {
  build = replaceOnce(
    build,
    "import { renderCockpit } from './lib/render-cockpit.mjs';",
    "import { renderCockpit } from './lib/render-cockpit.mjs';\nimport { renderFeatures } from './lib/render-features.mjs';",
    'feature-renderer-import',
  );
  build = replaceOnce(
    build,
    "const PUBLISH_ALLOWLIST = ['index.html', 'contentstroom.html', 'status.json', '.nojekyll'];",
    "const PUBLISH_ALLOWLIST = ['index.html', 'contentstroom.html', 'features.html', 'status.json', '.nojekyll'];",
    'publish-allowlist',
  );
  build = replaceOnce(
    build,
    "const NAV_NAAR_CONTENTSTROOM = '<nav class=\"pagenav\"><a href=\"./contentstroom.html\">Contentstroom — de volledige doorstroom-plaat →</a></nav>';\nconst NAV_NAAR_COCKPIT = '<nav class=\"pagenav\"><a href=\"./\">← terug naar de cockpit</a></nav>';",
    "const NAV_NAAR_CONTENTSTROOM = '<nav class=\"pagenav\"><a href=\"./contentstroom.html\">Contentstroom — de volledige doorstroom-plaat →</a> · <a href=\"./features.html\">Alle producten en features →</a></nav>';\nconst NAV_NAAR_COCKPIT = '<nav class=\"pagenav\"><a href=\"./\">← terug naar de cockpit</a> · <a href=\"./features.html\">Alle producten en features →</a></nav>';\nconst NAV_VAN_FEATURES = '<nav class=\"pagenav\"><a href=\"./\">← terug naar de cockpit</a> · <a href=\"./contentstroom.html\">Contentstroom →</a></nav>';",
    'feature-navigation',
  );
  build = replaceOnce(
    build,
    "  const textPolicy = readTextPolicy(await readJson('data/publish-text.json', {}));\n  const raw = await buildSnapshot();",
    "  const textPolicy = readTextPolicy(await readJson('data/publish-text.json', {}));\n  const productFeatures = await readJson('data/product-features.json', null);\n  const raw = await buildSnapshot();",
    'feature-catalog-read',
  );
  build = replaceOnce(
    build,
    "    ...validate(await readJson('contracts/status-json.schema.json', {}), status),\n  ];",
    "    ...validate(await readJson('contracts/status-json.schema.json', {}), status),\n    ...validate(await readJson('contracts/product-features.schema.json', {}), productFeatures),\n  ];",
    'feature-schema-gate',
  );
  build = replaceOnce(
    build,
    "  const cockpitHtml = renderCockpit(snapshot, { refreshSeconds: REFRESH_SECONDS, nav: NAV_NAAR_CONTENTSTROOM });\n  const contentstroomHtml = renderHtml(snapshot, { refreshSeconds: REFRESH_SECONDS, nav: NAV_NAAR_COCKPIT });",
    "  const cockpitHtml = renderCockpit(snapshot, { refreshSeconds: REFRESH_SECONDS, nav: NAV_NAAR_CONTENTSTROOM });\n  const contentstroomHtml = renderHtml(snapshot, { refreshSeconds: REFRESH_SECONDS, nav: NAV_NAAR_COCKPIT });\n  const featuresHtml = renderFeatures(productFeatures, {\n    generatedAt: snapshot.generatedAt, refreshSeconds: REFRESH_SECONDS, nav: NAV_VAN_FEATURES,\n  });",
    'feature-render-call',
  );
  build = replaceOnce(
    build,
    "  await writeFile(join(outDir, 'index.html'), cockpitHtml, 'utf8');\n  await writeFile(join(outDir, 'contentstroom.html'), contentstroomHtml, 'utf8');\n  await writeFile(join(outDir, 'status.json'), `${JSON.stringify(status, null, 2)}\\n`, 'utf8');",
    "  await writeFile(join(outDir, 'index.html'), cockpitHtml, 'utf8');\n  await writeFile(join(outDir, 'contentstroom.html'), contentstroomHtml, 'utf8');\n  await writeFile(join(outDir, 'features.html'), featuresHtml, 'utf8');\n  await writeFile(join(outDir, 'status.json'), `${JSON.stringify(status, null, 2)}\\n`, 'utf8');",
    'feature-output-write',
  );
  await writeFile(BUILD, build, 'utf8');
}

let workflow = await readFile(WORKFLOW, 'utf8');
if (!workflow.includes("! -name 'features.html'")) {
  workflow = replaceOnce(
    workflow,
    "! -name 'index.html' ! -name 'contentstroom.html' ! -name 'status.json' ! -name '.nojekyll'",
    "! -name 'index.html' ! -name 'contentstroom.html' ! -name 'features.html' ! -name 'status.json' ! -name '.nojekyll'",
    'workflow-output-allowlist',
  );
  await writeFile(WORKFLOW, workflow, 'utf8');
}

console.log('feature page integration applied');
