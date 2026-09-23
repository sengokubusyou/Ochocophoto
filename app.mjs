import { createPhotoZip } from './zip.mjs';
import { resolveRepository, uploadPhotos } from './uploader.mjs';

const config = window.GALLERY_CONFIG || {};
const repository = resolveRepository(config);
const $ = id => document.getElementById(id);
const state = { photos: [], index: 0, uploading: false };

document.title = config.title || 'よさこい写真帖';
document.querySelector('.brand-text strong').textContent = config.title || 'よさこい写真帖';
$('galleryTitle').textContent = config.performer || '踊りの記録';
$('galleryDescription').textContent = config.description || '演者の写真をまとめて閲覧・保存できます。';

function publicPath(path, kind) {
  const pattern = kind === 'original'
    ? /^photos\/[a-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i
    : /^thumbnails\/[a-z0-9_-]+\.jpg$/i;
  return pattern.test(path) ? new URL(`./${path}`, document.baseURI).href : null;
}

function showNotice(message, error = false) {
  const notice = $('notice');
  notice.textContent = message;
  notice.classList.toggle('error', error);
  notice.hidden = !message;
}

const metaFor = photo => [photo.event, photo.date].filter(Boolean).join(' · ') || 'よさこい';

function renderGallery() {
  const grid = $('gallery');
  grid.replaceChildren();
  $('photoCount').textContent = new Intl.NumberFormat('ja-JP').format(state.photos.length);
  $('downloadAll').disabled = state.photos.length === 0;
  $('emptyState').hidden = state.photos.length !== 0;
  for (const [index, photo] of state.photos.entries()) {
    const figure = document.createElement('figure');
    figure.className = 'photo-card';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'photo-open';
    open.setAttribute('aria-label', `${photo.title || '写真'}を拡大表示`);
    const image = document.createElement('img');
    image.src = publicPath(photo.thumbnailPath, 'thumbnail');
    image.alt = photo.title || 'よさこいの写真';
    image.loading = 'lazy';
    image.decoding = 'async';
    open.append(image);
    open.addEventListener('click', () => openPhoto(index));
    const caption = document.createElement('figcaption');
    caption.className = 'photo-info';
    const detail = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = photo.title || 'よさこいの写真';
    const meta = document.createElement('small');
    meta.textContent = metaFor(photo);
    detail.append(title, meta);
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'card-save';
    save.textContent = '↓';
    save.setAttribute('aria-label', `${photo.title || '写真'}を保存`);
    save.addEventListener('click', () => savePhoto(photo));
    caption.append(detail, save);
    figure.append(open, caption);
    grid.append(figure);
  }
}

async function loadPhotos() {
  try {
    const response = await fetch(`./data/photos.json?v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = await response.json();
    if (manifest.version !== 1 || !Array.isArray(manifest.photos)) throw new Error('写真一覧の形式が違います');
    state.photos = manifest.photos.filter(photo => photo && publicPath(photo.originalPath, 'original') && publicPath(photo.thumbnailPath, 'thumbnail'));
    renderGallery();
    showNotice('');
  } catch {
    state.photos = [];
    renderGallery();
    showNotice('写真一覧を読み込めませんでした。しばらくしてから再読み込みしてください。', true);
  }
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function savePhoto(photo) {
  try {
    const response = await fetch(publicPath(photo.originalPath, 'original'));
    if (!response.ok) throw new Error('写真を取得できませんでした。公開反映後にもう一度お試しください。');
    const name = String(photo.filename || photo.originalPath.split('/').pop()).replace(/[\\/\x00-\x1f\x7f]/g, '_');
    triggerDownload(await response.blob(), name);
  } catch (error) { showNotice(error.message, true); }
}

function updateLightbox() {
  const photo = state.photos[state.index];
  $('largePhoto').src = publicPath(photo.originalPath, 'original');
  $('largePhoto').alt = photo.title || 'よさこいの写真';
  $('photoTitle').textContent = photo.title || 'よさこいの写真';
  $('photoMeta').textContent = metaFor(photo);
  $('photoPosition').textContent = `${state.index + 1} / ${state.photos.length}`;
  $('prevPhoto').disabled = state.index === 0;
  $('nextPhoto').disabled = state.index === state.photos.length - 1;
}

function openPhoto(index) {
  state.index = index;
  updateLightbox();
  $('photoDialog').showModal();
}

$('closePhoto').addEventListener('click', () => $('photoDialog').close());
$('prevPhoto').addEventListener('click', () => { if (state.index > 0) { state.index--; updateLightbox(); } });
$('nextPhoto').addEventListener('click', () => { if (state.index < state.photos.length - 1) { state.index++; updateLightbox(); } });
$('downloadPhoto').addEventListener('click', () => savePhoto(state.photos[state.index]));
document.addEventListener('keydown', event => {
  if (!$('photoDialog').open) return;
  if (event.key === 'ArrowLeft' && state.index > 0) { state.index--; updateLightbox(); }
  if (event.key === 'ArrowRight' && state.index < state.photos.length - 1) { state.index++; updateLightbox(); }
});

$('downloadAll').addEventListener('click', async () => {
  const button = $('downloadAll');
  button.disabled = true;
  try {
    const entries = state.photos.map(photo => ({ name: photo.filename || 'photo.jpg', url: publicPath(photo.originalPath, 'original') }));
    const archive = await createPhotoZip(entries, fetch, (current, total) => showNotice(`ZIPを作成しています… ${current} / ${total} 枚`));
    triggerDownload(archive, 'yosakoi-photos.zip');
    showNotice(`${entries.length}枚の写真をZIPで保存しました。`);
  } catch (error) { showNotice(error.message, true); }
  finally { button.disabled = state.photos.length === 0; }
});

const uploadDialog = $('uploadDialog');
function closeUpload() {
  if (state.uploading) return;
  uploadDialog.close();
  $('githubToken').value = '';
  $('uploadStatus').hidden = true;
}
$('openUpload').addEventListener('click', () => {
  const info = $('repoDetails');
  info.textContent = repository
    ? `保存先：${repository.owner}/${repository.repo} · ${repository.branch} ブランチ`
    : '保存先を判定できません。site-config.js に owner と repo を設定してください。';
  info.classList.toggle('error', !repository);
  uploadDialog.showModal();
});
$('closeUpload').addEventListener('click', closeUpload);
$('cancelUpload').addEventListener('click', closeUpload);
uploadDialog.addEventListener('cancel', event => { if (state.uploading) event.preventDefault(); else $('githubToken').value = ''; });

function listSelected() {
  const holder = $('selectedFiles');
  holder.replaceChildren();
  for (const file of $('photoFiles').files) {
    const tag = document.createElement('span');
    tag.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
    holder.append(tag);
  }
}
$('photoFiles').addEventListener('change', listSelected);
const dropZone = $('dropZone');
dropZone.addEventListener('dragover', event => { event.preventDefault(); dropZone.classList.add('dragging'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', event => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
  if (event.dataTransfer?.files.length) { $('photoFiles').files = event.dataTransfer.files; listSelected(); }
});

function uploadMessage(message, error = false) {
  const status = $('uploadStatus');
  status.textContent = message;
  status.classList.toggle('error', error);
  status.hidden = !message;
}

$('uploadForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.uploading) return;
  state.uploading = true;
  $('submitUpload').disabled = true;
  $('closeUpload').disabled = true;
  $('cancelUpload').disabled = true;
  try {
    const additions = await uploadPhotos({
      repository, token: $('githubToken').value,
      files: [...$('photoFiles').files], event: $('eventName').value,
      date: $('shootDate').value, onProgress: uploadMessage
    });
    uploadMessage(`${additions.length}枚を登録しました。公開サイトへの反映には数分かかることがあります。反映後にページを再読み込みしてください。`);
    $('githubToken').value = '';
    $('photoFiles').value = '';
    listSelected();
  } catch (error) { uploadMessage(error.message || 'アップロードに失敗しました。', true); }
  finally {
    state.uploading = false;
    $('submitUpload').disabled = false;
    $('closeUpload').disabled = false;
    $('cancelUpload').disabled = false;
  }
});

loadPhotos();
