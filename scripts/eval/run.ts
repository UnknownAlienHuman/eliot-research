const contour = process.argv[2];
if (contour !== 'k0' && contour !== 'k1' && contour !== 'k2' && contour !== 'k3' && contour !== 'k6') {
  throw new Error('Usage: pnpm eval k0|k1|k2|k3|k6 (other contours are not implemented yet).');
}
if (contour === 'k2' && process.argv.includes('--models-browser')) {
  const { runCommandCodeBrowser } = await import('./command-code-browser.mjs');
  await runCommandCodeBrowser();
} else if (contour === 'k2' && process.argv.includes('--command-code-smoke')) {
  const { runCommandCodeSmoke } = await import('./command-code.ts');
  await runCommandCodeSmoke();
} else if (contour === 'k6' && process.argv.includes('--replacement')) {
  await import('./k6-replacement.mjs');
} else {
  await import('./' + contour + '.ts');
}
