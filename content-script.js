(function () {
  const Ext = globalThis.FlickrMetaExtension;
  const BUTTON_ID = 'flickr-meta-launcher';
  const STYLE_ID = 'flickr-meta-launcher-style';
  const OWNERSHIP_CACHE_TTL = 30000;
  let ownershipCache = {
    photoId: '',
    canEditPhoto: null,
    updatedAt: 0,
  };
  let launcherSyncPromise = null;

  init();

  function init() {
    patchHistoryState();
    syncLauncher();
    observePageChanges();
    window.addEventListener('popstate', syncLauncher);
    window.addEventListener('hashchange', syncLauncher);
    setInterval(syncLauncher, 500);
  }

  function getMeta(name, attr = 'content') {
    const el = document.querySelector(`meta[${attr === 'content' ? 'property' : 'name'}="${CSS.escape(name)}"]`);
    return el ? String(el.getAttribute(attr) || '').trim() : '';
  }

  function extractPhotoId() {
    return Ext.extractPhotoId(location.href);
  }

  function findImageUrl() {
    const metaCandidates = [
      getMeta('og:image'),
      getMeta('twitter:image'),
      getMeta('twitter:image:src'),
    ].filter(Boolean);
    if (metaCandidates.length) {
      return metaCandidates[0];
    }

    const images = Array.from(document.images)
      .map((img) => img.currentSrc || img.src || '')
      .filter((src) => /staticflickr|flickr/i.test(src));

    return images[0] || '';
  }

  function readVisibility() {
    const menuItems = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menuitem"]'));
    const selectedItem = menuItems.find((item) => item.classList && item.classList.contains('selected-item'))
      || document.querySelector('li.selected-item[role="menuitem"], [role="menuitem"].selected-item');
    const selected = cleanText(selectedItem?.textContent || '').toLowerCase();

    if (selected.includes('friends & family') || selected.includes('friends and family')) {
      return 'friends+family';
    }
    if (selected === 'friends') {
      return 'friends';
    }
    if (selected === 'family') {
      return 'family';
    }
    if (selected === 'public') {
      return 'public';
    }
    if (selected === 'private') {
      return 'private';
    }

    const label = cleanText(
      document.querySelector('[aria-label*="Viewing privacy"], [aria-label*="privacy"], [data-testid*="privacy"], [class*="privacy"]')?.textContent || ''
    ).toLowerCase();
    if (label.includes('friends & family') || label.includes('friends and family')) {
      return 'friends+family';
    }
    if (label.includes('friends')) {
      return 'friends';
    }
    if (label.includes('family')) {
      return 'family';
    }
    if (label.includes('public')) {
      return 'public';
    }
    if (label.includes('private')) {
      return 'private';
    }

    return 'unknown';
  }

  function readCurrentField(keywords) {
    const el = Ext.getFieldValueFromDocument(document, keywords);
    if (!el) {
      return '';
    }
    if (el.isContentEditable) {
      return String(el.textContent || '').trim();
    }
    return String(el.value || '').trim();
  }

  function cleanText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stripFlickrSuffix(title) {
    return cleanText(title).replace(/\s*[\-|•|]\s*Flickr\s*$/i, '').trim();
  }

  function readPageTitleCandidate() {
    const exactPhotoTitle = cleanText(
      document.querySelector('div.title-desc-block h1.editable.meta-field.photo-title, h1.editable.meta-field.photo-title, h1.photo-title')?.textContent || ''
    );
    if (exactPhotoTitle) {
      return exactPhotoTitle;
    }

    const visibleHeading = readVisibleHeadingCandidate();
    if (visibleHeading) {
      return visibleHeading;
    }

    const metaTitle = cleanText(getMeta('og:title') || '');
    const pageTitle = cleanText(document.title || '');
    const candidate = stripFlickrSuffix(metaTitle || pageTitle);
    return candidate || '';
  }

  function readPageDescriptionCandidate() {
    const exactPhotoDescription = cleanText(
      document.querySelector('h2.editable.meta-field.photo-desc p, h2.meta-field.photo-desc p, .photo-desc p')?.textContent || ''
    );
    if (exactPhotoDescription) {
      return exactPhotoDescription;
    }

    const visibleDescription = readVisibleDescriptionCandidate();
    if (visibleDescription) {
      return visibleDescription;
    }

    const metaDescription = cleanText(getMeta('description') || getMeta('og:description') || '');
    if (metaDescription) {
      return metaDescription;
    }

    const article = document.querySelector('article');
    if (article) {
      const text = cleanText(article.innerText || '');
      if (text.length > 40) {
        return text;
      }
    }

    return '';
  }

  function readVisibleHeadingCandidate() {
    const headings = Array.from(document.querySelectorAll('main h1, main h2, article h1, article h2, h1, h2, [role="heading"]'))
      .map((node) => cleanText(node.textContent || ''))
      .filter((text) => text && !looksLikeUiLabel(text));

    return headings.find((text) => text.length >= 4 && text.length <= 140) || '';
  }

  function readVisibleDescriptionCandidate() {
    const nodes = Array.from(document.querySelectorAll('main p, article p, main div, article div'))
      .map((node) => cleanText(node.textContent || ''))
      .filter((text) => text.length >= 30 && text.length <= 500 && !looksLikeUiLabel(text));

    return nodes.find((text) => /[.!?]/.test(text)) || nodes[0] || '';
  }

  function looksLikeUiLabel(text) {
    const lowered = String(text || '').toLowerCase();
    return [
      'add a comment',
      'add comment',
      'load page',
      'generate draft',
      'apply to page',
      'publish to flickr',
      'copy json',
      'options',
      'flickr page detected',
      'not on a flickr photo page',
      'not connected',
      'connected as',
    ].some((phrase) => lowered.includes(phrase));
  }

  function readPageTagsCandidate() {
    const sources = Array.from(document.querySelectorAll('.view.sub-photo-tags-tag-view ul.tags-list li.tag a.tag-text, .sub-photo-tags-tag-view ul.tags-list li.tag a.tag-text, ul.tags-list li.tag a.tag-text'))
      .map((node) => cleanText(node.getAttribute('title') || node.textContent || ''))
      .filter((text) => text && !looksLikeUiLabel(text));

    if (!sources.length) {
      return '';
    }

    const seen = new Set();
    const unique = [];
    for (const tag of sources) {
      if (tag == null) {
        continue;
      }

      const value = cleanText(tag);
      if (!value) {
        continue;
      }

      const key = String(value).toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(value);
    }

    return unique.join(', ');
  }

  async function collectPageContext() {
    const photoId = extractPhotoId();
    const ownership = await resolvePhotoOwnership(photoId);
    const canEditPhoto = Boolean(ownership && ownership.canEditPhoto);
    const pageTitle = readPageTitleCandidate();
    const description = readPageDescriptionCandidate();
    const imageUrl = findImageUrl();
    const currentTitle = pageTitle || readCurrentField(['title', 'photo title', 'name']);
    const currentDescription = description || readCurrentField(['description', 'caption', 'details']);
    const currentTags = readPageTagsCandidate() || readCurrentField(['tag', 'tags', 'keywords']);

    return {
      photoId,
      pageUrl: location.href,
      photoPageUrl: location.href,
      pageTitle,
      description,
      imageUrl,
      currentTitle,
      currentDescription,
      currentTags,
      visibility: readVisibility(),
      canEditPhoto,
      ownership,
      isFlickrPage: /flickr\.com/i.test(location.hostname),
      hasEditableFields: Boolean(
        Ext.getFieldValueFromDocument(document, ['title']) ||
        Ext.getFieldValueFromDocument(document, ['description']) ||
        Ext.getFieldValueFromDocument(document, ['tags'])
      ),
    };
  }

  function isFlickrProductPage() {
    if (!/https:\/\/www\.flickr\.com\/photos\/[^/]+\/\d+/i.test(location.href)) {
      return false;
    }

    return true;
  }

  function injectLauncher() {
    if (!isFlickrProductPage() || document.getElementById(BUTTON_ID)) {
      return;
    }

    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        #${BUTTON_ID} {
          position: fixed;
          right: 18px;
          bottom: 18px;
          z-index: 2147483647;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          border: 1px solid #d7d7dc;
          border-radius: 999px;
          padding: 11px 16px;
          background: linear-gradient(180deg, #ffffff, #f7f7f8);
          color: #0063dc;
          font: 600 13px/1.1 "Helvetica Neue", Helvetica, Arial, sans-serif;
          box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
          cursor: pointer;
          user-select: none;
        }

        #${BUTTON_ID}:hover {
          background: #f4f9ff;
          border-color: #c3d8f3;
          transform: translateY(-1px);
        }

        #${BUTTON_ID}::before {
          content: '';
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: linear-gradient(180deg, #0063dc 0%, #ff0084 100%);
          flex: none;
        }
      `;
      document.documentElement.appendChild(style);
    }

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = 'Open Flickr Metadata Assistant Panel';
    button.setAttribute('aria-label', 'Open Flickr Metadata Assistant Panel');
    button.dataset.popupUrl = chrome.runtime.getURL('popup.html');
    button.addEventListener('click', openPopup);

    document.documentElement.appendChild(button);
  }

  function removeLauncher() {
    document.getElementById(BUTTON_ID)?.remove();
  }

  function syncLauncher() {
    if (!isFlickrProductPage()) {
      removeLauncher();
      return;
    }

    const photoId = extractPhotoId();
    const cached = ownershipCache.photoId === photoId && (Date.now() - ownershipCache.updatedAt) < OWNERSHIP_CACHE_TTL;
    if (cached) {
      if (ownershipCache.canEditPhoto) {
        injectLauncher();
      } else {
        removeLauncher();
      }
      return Promise.resolve();
    }

    if (launcherSyncPromise) {
      return launcherSyncPromise;
    }

    launcherSyncPromise = resolvePhotoOwnership(photoId).then((ownership) => {
      ownershipCache = {
        photoId,
        canEditPhoto: Boolean(ownership && ownership.canEditPhoto),
        updatedAt: Date.now(),
      };

      if (ownership && ownership.canEditPhoto) {
        injectLauncher();
        return;
      }

      removeLauncher();
    }).catch(() => {
      removeLauncher();
    }).finally(() => {
      launcherSyncPromise = null;
    });

    return launcherSyncPromise;
  }

  function observePageChanges() {
    const observer = new MutationObserver(() => {
      syncLauncher();
    });

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
    });
  }

  function patchHistoryState() {
    const pushState = history.pushState;
    const replaceState = history.replaceState;

    history.pushState = function (...args) {
      const result = pushState.apply(this, args);
      window.dispatchEvent(new Event('flickr-meta:urlchange'));
      return result;
    };

    history.replaceState = function (...args) {
      const result = replaceState.apply(this, args);
      window.dispatchEvent(new Event('flickr-meta:urlchange'));
      return result;
    };

    window.addEventListener('flickr-meta:urlchange', syncLauncher);
  }

  function openPopup() {
    const fallbackUrl = document.getElementById(BUTTON_ID)?.dataset.popupUrl || '';

    try {
      chrome.runtime.sendMessage({ type: 'flickr-meta:open-popup' }, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          if (fallbackUrl) {
            window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
          }
        }
      });
    } catch {
      if (fallbackUrl) {
        window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
      }
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') {
      return;
    }

    if (message.type === 'flickr-meta:collect-context') {
      collectPageContext()
        .then((context) => sendResponse({ ok: true, context }))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message.type === 'flickr-meta:request-launcher-sync') {
      syncLauncher();
      sendResponse({ ok: true });
      return;
    }
  });

  async function resolvePhotoOwnership(photoId) {
    if (!photoId) {
      return {
        canEditPhoto: false,
        reason: 'Missing photo id.',
      };
    }

    try {
      const response = await sendMessage({ type: 'flickr-meta:photo-ownership', photoId });
      return response.ownership || { canEditPhoto: false };
    } catch {
      return {
        canEditPhoto: false,
        reason: 'Unable to verify ownership.',
      };
    }
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        if (!response || response.ok === false) {
          reject(new Error(response?.error || 'Unknown error.'));
          return;
        }

        resolve(response);
      });
    });
  }
})();
