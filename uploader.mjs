const MAX_FILE_BYTES = 25 * 1024 * 1024;
const allowedTypes = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp']
]);

export function resolveRepository(config, location = window.location) {
  const host = location.hostname.toLowerCase();
  const owner = config.owner || (host.endsWith('.github.io') ? host.slice(0, -'.github.io'.length) : '');
  const firstPath = location.pathname.split('/').filter(Boolean)[0];
  const repo = config.repo || (host.endsWith('.github.io') ? firstPath || `${owner}.github.io` : '');
  const branch = config.branch || 'main';
  if (!/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(owner) || !/^[a-z\d._-]+$/i.test(repo) || !/^[a-z\d._/-]+$/i.test(branch) || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) {
    return null;
  }
  return { owner, repo, branch };
}

function encodeBase64(bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return btoa(chunks.join(''));
}

function decodeBase64Utf8(base64) {
  const binary = atob(base64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

async function thumbnail(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 900 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('サムネイルを作成できませんでした。')), 'image/jpeg', 0.82));
}

function apiFor(repository) {
  return `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
}

async function api(path, token, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2026-03-10',
      ...options.headers
    }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403
      ? 'トークンの期限と対象リポジトリの Contents 書き込み権限を確認してください。'
      : response.status === 404 ? 'リポジトリ名、公開ブランチ、または data/photos.json を確認してください。' : '';
    const error = new Error(`GitHub API ${response.status}: ${result.message || '処理に失敗しました。'} ${hint}`.trim());
    error.status = response.status;
    throw error;
  }
  return result;
}

async function createBlob(apiRoot, token, bytes) {
  const result = await api(`${apiRoot}/git/blobs`, token, {
    method: 'POST',
    body: JSON.stringify({ content: encodeBase64(bytes), encoding: 'base64' })
  });
  return result.sha;
}

export async function uploadPhotos({ repository, token, files, event, date, onProgress = () => {} }) {
  if (!repository) throw new Error('リポジトリを判定できません。site-config.js に owner と repo を設定してください。');
  if (!token.trim()) throw new Error('GitHub トークンを入力してください。');
  if (!files.length || files.length > 30) throw new Error('1〜30枚の写真を選択してください。');
  for (const file of files) {
    if (!allowedTypes.has(file.type)) throw new Error(`${file.name}: JPEG、PNG、WebP の写真を選んでください。`);
    if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name}: 25MBを超えています。`);
  }
  const root = apiFor(repository);
  const refPath = `${root}/git/refs/heads/${repository.branch.split('/').map(encodeURIComponent).join('/')}`;
  onProgress('GitHubの写真一覧を確認しています…');
  const ref = await api(refPath, token);
  const headSha = ref.object.sha;
  const [commit, currentFile] = await Promise.all([
    api(`${root}/git/commits/${headSha}`, token),
    api(`${root}/contents/data/photos.json?ref=${encodeURIComponent(headSha)}`, token)
  ]);
  if (!currentFile.content) throw new Error('写真一覧を読み込めません。data/photos.json を確認してください。');
  const manifest = JSON.parse(decodeBase64Utf8(currentFile.content));
  if (manifest.version !== 1 || !Array.isArray(manifest.photos)) throw new Error('写真一覧の形式が正しくありません。');

  const treeEntries = [];
  const additions = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress(`${i + 1} / ${files.length} 枚目を登録しています…`);
    const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const originalPath = `photos/${id}.${allowedTypes.get(file.type)}`;
    const thumbnailPath = `thumbnails/${id}.jpg`;
    let thumb;
    try { thumb = await thumbnail(file); }
    catch { throw new Error(`${file.name}: ブラウザーで画像を読み取れませんでした。`); }
    const originalBytes = new Uint8Array(await file.arrayBuffer());
    const thumbBytes = new Uint8Array(await thumb.arrayBuffer());
    const originalSha = await createBlob(root, token, originalBytes);
    const thumbSha = await createBlob(root, token, thumbBytes);
    treeEntries.push(
      { path: originalPath, mode: '100644', type: 'blob', sha: originalSha },
      { path: thumbnailPath, mode: '100644', type: 'blob', sha: thumbSha }
    );
    additions.push({
      id, filename: file.name, title: file.name.replace(/\.[^.]+$/, ''),
      event: event.trim(), date: date || '', bytes: file.size,
      originalPath, thumbnailPath, addedAt: new Date().toISOString()
    });
  }

  onProgress('写真一覧を更新しています…');
  const updated = { version: 1, photos: [...additions, ...manifest.photos] };
  const manifestSha = await createBlob(root, token, new TextEncoder().encode(JSON.stringify(updated, null, 2) + '\n'));
  treeEntries.push({ path: 'data/photos.json', mode: '100644', type: 'blob', sha: manifestSha });
  const tree = await api(`${root}/git/trees`, token, {
    method: 'POST', body: JSON.stringify({ base_tree: commit.tree.sha, tree: treeEntries })
  });
  const newCommit = await api(`${root}/git/commits`, token, {
    method: 'POST', body: JSON.stringify({ message: `写真を${files.length}枚追加`, tree: tree.sha, parents: [headSha] })
  });
  await api(refPath, token, { method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha, force: false }) });
  return additions;
}
