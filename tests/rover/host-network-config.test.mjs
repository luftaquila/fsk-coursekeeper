import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repoRoot = new URL('../../', import.meta.url);

async function readRepoFile(path) {
  return readFile(new URL(path, repoRoot), 'utf8');
}

function iniSection(text, sectionName) {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(`[${sectionName}]`);
  assert.notEqual(start, -1, `missing [${sectionName}] section`);
  const endOffset = lines.slice(start + 1).findIndex(line => line.startsWith('['));
  const sectionLines = lines.slice(start + 1, endOffset === -1 ? undefined : start + 1 + endOffset);
  return Object.fromEntries(
    sectionLines
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(line => {
        const separator = line.indexOf('=');
        assert.notEqual(separator, -1, `invalid keyfile line: ${line}`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

test('rover host keeps deterministic public DNS behind MagicDNS', async () => {
  const conf = await readRepoFile(
    'rover/host/files/etc/NetworkManager/conf.d/90-fsk-coursekeeper-dns.conf',
  );
  const dns = iniSection(conf, 'global-dns-domain-*');

  // NetworkManager.conf lists are comma-separated.
  assert.deepEqual(dns.servers.split(','), ['1.1.1.1', '8.8.8.8']);
});

test('devices keep their DNS off Tailscale so a stale clock can still sync', async () => {
  for (const path of ['rover/host/install.sh', 'rover/gps/host/install.sh']) {
    const installer = await readRepoFile(path);
    // Both the first login and a later run set it; the tailnet name stays the Pi's host name.
    assert.match(installer, /^\s+tailscale up --accept-dns=false$/m, path);
    assert.match(installer, /^\s+tailscale set --accept-dns=false$/m, path);
    assert.doesNotMatch(installer, /--hostname/, path);
    assert.doesNotMatch(installer, /time-wait-sync/, path);
  }
});

test('device installers run from main so a piped script is read whole', async () => {
  for (const path of ['rover/host/install.sh', 'rover/gps/host/install.sh']) {
    const installer = await readRepoFile(path);
    const lines = installer.trimEnd().split('\n');
    assert.equal(lines.at(-1), 'main "$@"', path);
    assert.match(installer, /^REPO="@REPO@"$/m, path);
    assert.match(installer, /^VERSION="@VERSION@"$/m, path);
  }
});
