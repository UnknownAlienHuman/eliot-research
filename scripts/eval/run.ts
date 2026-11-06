const contour = process.argv[2];
if (contour !== 'k0' && contour !== 'k1' && contour !== 'k2' && contour !== 'k3' && contour !== 'k4') {
  throw new Error('Usage: pnpm eval k0|k1|k2|k3|k4 (other contours are not implemented yet).');
}
await import('./' + (contour === 'k2' && process.argv.includes('--context-only') ? 'k2-context'
  : contour === 'k2' && process.argv.includes('--admission-only') ? 'chat-admission'
  : contour === 'k2' && process.argv.includes('--view-isolation') ? 'view-isolation'
  : contour === 'k2' && process.argv.includes('--send-browser') ? 'send-browser'
  : contour === 'k2' && process.argv.includes('--project-browser') ? 'project-browser'
  : contour === 'k3' && process.argv.includes('--retry-only') ? 'k3-retry'
  : contour === 'k3' && process.argv.includes('--metadata-only') ? 'k3-metadata'
  : contour === 'k3' && process.argv.includes('--overview-only') ? 'k3-overview'
  : contour === 'k3' && process.argv.includes('--overview-browser') ? 'overview-browser'
  : contour === 'k3' && process.argv.includes('--question-browser') ? 'question-browser'
  : contour === 'k3' && process.argv.includes('--understanding-browser') ? 'understanding-browser'
  : contour === 'k1' && process.argv.includes('--library-only') ? 'k1-library'
  : contour === 'k1' && process.argv.includes('--library-browser') ? 'library-browser'
  : contour === 'k1' && process.argv.includes('--projects-browser') ? 'projects-browser'
  : contour === 'k1' && process.argv.includes('--ocr') ? 'k1-ocr' : contour) + '.ts');
