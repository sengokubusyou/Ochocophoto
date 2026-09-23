import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createPhotoZip } from '../zip.mjs';
import { resolveRepository, uploadPhotos } from '../uploader.mjs';

assert.deepEqual(
  resolveRepository({ branch: 'main' }, { hostname: 'dance.github.io', pathname: '/gallery/' }),
  { owner: 'dance', repo: 'gallery', branch: 'main' }
);
assert.equal(resolveRepository({}, { hostname: 'example.com', pathname: '/' }), null);

const source = [new Uint8Array([1, 2, 3]), new TextEncoder().encode('yosakoi')];
let fetched = 0;
const archive = await createPhotoZip(
  [{ name: '踊り.jpg', url: '/one' }, { name: '踊り.jpg', url: '/two' }],
  async () => new Response(source[fetched++])
);
await writeFile('/tmp/yosakoi-smoke.zip', Buffer.from(await archive.arrayBuffer()));
assert.equal(fetched, 2);

globalThis.createImageBitmap = async () => ({ width: 100, height: 200, close() {} });
globalThis.document = { createElement: () => ({
  width: 0, height: 0,
  getContext: () => ({ fillRect() {}, drawImage() {}, set fillStyle(value) {} }),
  toBlob: callback => callback(new Blob([new Uint8Array([4, 5])], { type: 'image/jpeg' }))
}) };

const calls = [];
let blobNumber = 0;
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url, options });
  const path = new URL(url).pathname;
  let value;
  if (path.endsWith('/git/refs/heads/main')) value = options.method === 'PATCH' ? { object: { sha: 'new' } } : { object: { sha: 'old' } };
  else if (path.endsWith('/git/commits/old')) value = { tree: { sha: 'old-tree' } };
  else if (path.endsWith('/contents/data/photos.json')) value = { content: Buffer.from(JSON.stringify({ version: 1, photos: [] })).toString('base64') };
  else if (path.endsWith('/git/blobs')) value = { sha: `blob-${++blobNumber}` };
  else if (path.endsWith('/git/trees')) value = { sha: 'new-tree' };
  else if (path.endsWith('/git/commits')) value = { sha: 'new' };
  else throw new Error(`Unexpected API call: ${url}`);
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
};

const file = new File([new Uint8Array([1, 2, 3])], '踊り.jpg', { type: 'image/jpeg' });
const photos = await uploadPhotos({
  repository: { owner: 'dance', repo: 'gallery', branch: 'main' },
  token: 'test-secret', files: [file], event: '祭り', date: '2026-09-23'
});
assert.equal(photos.length, 1);
assert.equal(photos[0].filename, '踊り.jpg');
const treeCall = calls.find(call => call.url.endsWith('/git/trees'));
const tree = JSON.parse(treeCall.options.body);
assert.equal(tree.base_tree, 'old-tree');
assert.deepEqual(tree.tree.map(entry => entry.path).sort(),
  ['data/photos.json', photos[0].originalPath, photos[0].thumbnailPath].sort());
const refCall = calls.find(call => call.options.method === 'PATCH');
assert.deepEqual(JSON.parse(refCall.options.body), { sha: 'new', force: false });
assert(calls.every(call => call.options.headers.Authorization === 'Bearer test-secret'));
console.log('Repository resolution, ZIP construction, and atomic GitHub update: OK');
