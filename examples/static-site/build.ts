// Copy public/ to dist/ and inject the Edge Script URL into HTML and JS.
const apiUrl = process.env.API_URL ?? "";

await Bun.$`rm -rf dist && cp -R public dist`;
for await (const file of new Bun.Glob("**/*.{html,js}").scan("dist")) {
  const path = `dist/${file}`;
  const text = await Bun.file(path).text();
  await Bun.write(path, text.replaceAll("__API_URL__", apiUrl));
}
console.log(`built dist/ (API_URL=${apiUrl || "<unset>"})`);
