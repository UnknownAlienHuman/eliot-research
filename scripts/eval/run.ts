const contour = process.argv[2];
if (contour !== 'k0' && contour !== 'k1' && contour !== 'k2' && contour !== 'k3' && contour !== 'k4') {
  throw new Error('Usage: pnpm eval k0|k1|k2|k3|k4 (other contours are not implemented yet).');
}
await import('./' + (contour === 'k1' && process.argv.includes('--ocr') ? 'k1-ocr' : contour) + '.ts');
