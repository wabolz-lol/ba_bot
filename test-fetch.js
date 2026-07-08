// Run with: node test-fetch.js
// This has nothing to do with the bot -- it just checks whether basic
// HTTPS fetch + gzip decoding works on this machine/network at all.

async function test(url) {
  try {
    const res = await fetch(url);
    const text = await res.text();
    console.log(`OK  (${res.status}) ${url}  [${text.length} bytes]`);
  } catch (err) {
    console.log(`FAIL ${url}`);
    console.log('  ->', err.message);
    if (err.cause) console.log('  cause ->', err.cause.message || err.cause);
  }
}

(async () => {
  console.log('Node version:', process.version);
  console.log('---');
  await test('https://example.com');
  await test('https://registry.npmjs.org/bedrock-protocol');
  await test('https://login.live.com/oauth20_connect.srf');
})();
