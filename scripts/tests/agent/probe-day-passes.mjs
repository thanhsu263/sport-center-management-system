const BASE = 'http://127.0.0.1:8090';

async function main() {
  console.log('--- Probing /desk/day-passes ---');
  const rHtml = await fetch(`${BASE}/desk/day-passes`);
  const html = await rHtml.text();
  console.log('HTML status:', rHtml.status);
  console.log('HTML length:', html.length);
  console.log('Contains <!DOCTYPE html>:', html.includes('<!DOCTYPE html>'));
  console.log('Contains root / app container:', html.includes('id="root"') || html.includes('id="__root"') || html.includes('root') || html.includes('<html'));
  
  console.log('--- Probing /v1/day-passes endpoints ---');
  for (const [method, path] of [
    ['GET', '/v1/day-passes'],
    ['POST', '/v1/day-passes'],
    ['POST', '/v1/day-passes/fake-id/use'],
    ['POST', '/v1/day-passes/fake-id/void'],
  ]) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    });
    const body = await res.text();
    console.log(`${method} ${path}: status ${res.status}, body: ${body.trim()}`);
  }
}

main().catch(err => {
  console.error('Error in probe:', err);
  process.exit(1);
});
