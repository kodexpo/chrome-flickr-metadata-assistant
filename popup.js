(function () {
  const Ext = globalThis.FlickrMetaExtension;

  const state = {
    tabId: null,
    context: null,
    draft: null,
    settings: null,
    auth: null,
  };

  const elements = {};

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    bindElements();
    bindEvents();
    await refresh();
  }

  function bindElements() {
    elements.statusText = document.getElementById('statusText');
    elements.contextSummary = document.getElementById('contextSummary');
    elements.authSummary = document.getElementById('authSummary');
    elements.connectionDot = document.getElementById('connectionDot');
    elements.titleInput = document.getElementById('titleInput');
    elements.descriptionInput = document.getElementById('descriptionInput');
    elements.tagsInput = document.getElementById('tagsInput');
    elements.notesInput = document.getElementById('notesInput');
    elements.removeLocationInput = document.getElementById('removeLocationInput');
    elements.sourceText = document.getElementById('sourceText');
    elements.confidenceText = document.getElementById('confidenceText');
    elements.footerText = document.getElementById('footerText');
    elements.refreshBtn = document.getElementById('refreshBtn');
    elements.draftBtn = document.getElementById('draftBtn');
    elements.publishBtn = document.getElementById('publishBtn');
    elements.copyBtn = document.getElementById('copyBtn');
    elements.optionsBtn = document.getElementById('optionsBtn');
  }

  function bindEvents() {
    elements.refreshBtn.addEventListener('click', () => refresh());
    elements.draftBtn.addEventListener('click', () => generateDraft());
    elements.publishBtn.addEventListener('click', () => publishDraft());
    elements.copyBtn.addEventListener('click', () => copyDraft());
    elements.optionsBtn.addEventListener('click', openOptions);

    elements.titleInput.addEventListener('input', syncDraftFromForm);
    elements.descriptionInput.addEventListener('input', syncDraftFromForm);
    elements.tagsInput.addEventListener('input', syncDraftFromForm);
    elements.removeLocationInput.addEventListener('change', syncDraftFromForm);
  }

  async function openOptions() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await sendMessage({
        type: 'flickr-meta:remember-opener-tab',
        tab: tab || null,
      });
    } catch {
      // Best effort only.
    }

    chrome.runtime.openOptionsPage();
  }

  async function refresh() {
    setStatus('Loading current tab...');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.tabId = tab && Number.isFinite(tab.id) ? tab.id : null;
    state.settings = await getSettings();

    try {
      const response = await sendMessage({ type: 'flickr-meta:collect-context', tabId: state.tabId });
      state.context = response.context;
      const stateResponse = await sendMessage({ type: 'flickr-meta:get-state' });
      state.auth = stateResponse.auth || null;
      renderAuth(state.auth);
      setStatus(state.context.isFlickrPage ? 'Flickr page detected.' : 'Not on a Flickr photo page.', state.context.isFlickrPage);
      elements.draftBtn.disabled = !state.context.isFlickrPage || !state.context.canEditPhoto;
      elements.publishBtn.disabled = true;
      elements.contextSummary.textContent = summarizeContext(state.context);

      if (!state.context.canEditPhoto) {
        renderDraft(null, true);
        setFooter('This photo is not editable by the current account.');
        updatePublishState();
        return;
      }

      const stored = await getLastDraftForPhoto(state.context.photoId);
      if (stored && stored.draft) {
        state.draft = stored.draft;
        renderDraft(state.draft);
        setFooter(`Loaded stored draft for ${state.context.photoId}.`);
      } else {
        state.draft = Ext.normalizeDraft(Ext.heuristicDraft(state.context), state.context, 'heuristic', null);
        renderDraft(state.draft);
        setFooter('Ready to generate a draft from the current page.');
      }
      updatePublishState();
    } catch (error) {
      state.context = null;
      state.draft = null;
      elements.draftBtn.disabled = true;
      elements.publishBtn.disabled = true;
      elements.contextSummary.textContent = '';
      elements.authSummary.textContent = '';
      setStatus(String(error.message || error), false);
      renderDraft(null, true);
      setFooter('Open a Flickr photo page to draft metadata.');
    }
  }

  async function generateDraft() {
    if (!state.context || !state.context.isFlickrPage) {
      return;
    }

    setStatus('Generating draft...');
    elements.draftBtn.disabled = true;

    try {
      const response = await sendMessage({
        type: 'flickr-meta:generate-draft',
        tabId: state.tabId,
        context: state.context,
      });

      state.draft = response.draft;
      renderDraft(state.draft);
      setStatus(`Draft ready from ${state.draft.source || 'ai'}.`, true);
      setFooter(`Saved draft for photo ${state.context.photoId}.`);
      updatePublishState();
    } catch (error) {
      setStatus(`Draft generation failed: ${String(error.message || error)}`, false);
      setFooter('The extension will fall back to heuristic drafting if needed.');
    } finally {
      elements.draftBtn.disabled = !state.context || !state.context.isFlickrPage;
    }
  }

  async function publishDraft() {
    if (!state.context || !state.context.isFlickrPage) {
      return;
    }

    syncDraftFromForm();
    if (!state.draft) {
      state.draft = currentFormDraft();
    }

    if (!confirm('Publish this draft to Flickr now?')) {
      return;
    }

    setStatus('Publishing to Flickr...');

    try {
      const response = await sendMessage({
        type: 'flickr-meta:publish-draft',
        tabId: state.tabId,
        context: state.context,
        draft: state.draft,
        removeLocation: elements.removeLocationInput.checked,
      });

      const bits = [];
      if (response.published) {
        bits.push('published');
      } else {
        bits.push('saved');
      }
      if (response.visibility) {
        bits.push(response.visibility);
      }
      if (response.photoUrl) {
        bits.push(response.photoUrl);
      }

      setStatus(`Flickr ${bits.join(' · ')}.`, true);
      setFooter('The draft has been sent to Flickr.');
      await reloadCurrentTab();
    } catch (error) {
      setStatus(`Publish failed: ${String(error.message || error)}`, false);
    }
  }

  async function copyDraft() {
    const draft = currentFormDraft();
    if (!draft) {
      return;
    }

    await navigator.clipboard.writeText(JSON.stringify(draft, null, 2));
    setStatus('Draft JSON copied to clipboard.', true);
  }

  function reloadCurrentTab() {
    if (!Number.isFinite(state.tabId)) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      chrome.tabs.reload(state.tabId, { bypassCache: true }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  }

  async function getSettings() {
    const response = await sendMessage({ type: 'flickr-meta:get-state' });
    return response.settings;
  }

  async function getLastDraftForPhoto(photoId) {
    if (!photoId) {
      return null;
    }

    const response = await sendMessage({ type: 'flickr-meta:get-last-draft' });
    const draft = response.draft;
    if (!draft || String(draft.photoId || '') !== String(photoId)) {
      return null;
    }

    return draft;
  }

  function renderDraft(draft, clear = false) {
    const current = clear ? null : draft;
    elements.titleInput.value = current ? String(current.title || '') : '';
    elements.descriptionInput.value = current ? String(current.description || '') : '';
    elements.tagsInput.value = current ? (Array.isArray(current.tags) ? current.tags.join(', ') : String(current.tags || '')) : '';
    elements.notesInput.value = current ? String(current.notes || '') : '';
    elements.removeLocationInput.checked = current ? current.removeLocation === true : false;
    elements.sourceText.textContent = current ? String(current.source || '-') : '-';
    elements.confidenceText.textContent = current ? String(current.confidence || '-') : '-';

    if (!clear && current) {
      state.draft = current;
    }

    updatePublishState();
  }

  function syncDraftFromForm() {
    state.draft = currentFormDraft();
  }

  function currentFormDraft() {
    const tags = elements.tagsInput.value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);

    return Ext.normalizeDraft({
      title: elements.titleInput.value,
      description: elements.descriptionInput.value,
      tags,
      confidence: state.draft && state.draft.confidence ? state.draft.confidence : 'medium',
      notes: elements.notesInput.value,
      removeLocation: Boolean(elements.removeLocationInput.checked),
      source: state.draft && state.draft.source ? state.draft.source : 'heuristic',
      model: state.draft && state.draft.model ? state.draft.model : null,
    }, state.context || {}, state.draft && state.draft.source ? state.draft.source : 'heuristic', state.draft && state.draft.model ? state.draft.model : null);
  }

  function summarizeContext(context) {
    if (!context) {
      return '';
    }

    const pieces = [];
    if (context.photoId) {
      pieces.push(`Photo ${context.photoId}`);
    }
    if (context.visibility) {
      pieces.push(`Visibility: ${context.visibility}`);
    }

    return pieces.join(' \u2022 ');
  }

  function renderAuth(auth) {
    if (!auth || !auth.connected) {
      elements.authSummary.textContent = 'Flickr not connected.';
      elements.publishBtn.disabled = true;
      elements.publishBtn.classList.add('hidden');
      return;
    }

    const bits = [];
    if (auth.username) {
      bits.push(`@${auth.username}`);
    }
    if (auth.fullname) {
      bits.push(auth.fullname);
    }

    elements.authSummary.textContent = bits.length
      ? `Connected as ${bits.join(' · ')}`
      : 'Flickr connected.';
    updatePublishState();
  }

  function updatePublishState() {
    const canPublish = Boolean(
      state.context &&
      state.context.isFlickrPage &&
      state.context.canEditPhoto &&
      state.draft &&
      state.auth &&
      state.auth.connected
    );

    elements.publishBtn.disabled = !canPublish;
  }

  function setStatus(text, ok = null) {
    elements.statusText.textContent = text;
    elements.connectionDot.className = 'dot';
    if (ok === true) {
      elements.connectionDot.classList.add('ready');
    } else if (ok === false) {
      elements.connectionDot.classList.add('warn');
    }
  }

  function setFooter(text) {
    elements.footerText.textContent = text;
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
