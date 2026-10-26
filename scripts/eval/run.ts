const contour = process.argv[2];
if (contour !== "k0" && contour !== "k1" && contour !== "k2") {
  throw new Error("Usage: pnpm eval k0|k1|k2 (other contours are not implemented yet).");
}
await import(`./${contour}.ts`);
