(function () {
  const Ext = globalThis.FlickrMetaExtension;

  const elements = {};

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    bindElements();
    bindEvents();
    elements.redirectUrl.value = chrome.identity.getRedirectURL('flickr');
    await loadSettings();
  }

  function bindElements() {
    elements.provider = document.getElementById('provider');
    elements.preferLocalFirst = document.getElementById('preferLocalFirst');
    elements.flickrApiKey = document.getElementById('flickrApiKey');
    elements.flickrApiSecret = document.getElementById('flickrApiSecret');
    elements.openaiApiKey = document.getElementById('openaiApiKey');
    elements.openaiModel = document.getElementById('openaiModel');
    elements.deepseekApiKey = document.getElementById('deepseekApiKey');
    elements.deepseekModel = document.getElementById('deepseekModel');
    elements.ollamaBaseUrl = document.getElementById('ollamaBaseUrl');
    elements.ollamaModel = document.getElementById('ollamaModel');
    elements.connectBtn = document.getElementById('connectBtn');
    elements.disconnectBtn = document.getElementById('disconnectBtn');
    elements.authStatus = document.getElementById('authStatus');
    elements.redirectUrl = document.getElementById('redirectUrl');
    elements.saveBtn = document.getElementById('saveBtn');
    elements.resetBtn = document.getElementById('resetBtn');
    elements.backBtn = document.getElementById('backBtn');
    elements.exportBtn = document.getElementById('exportBtn');
    elements.importBtn = document.getElementById('importBtn');
    elements.importFile = document.getElementById('importFile');
    elements.statusText = document.getElementById('statusText');
  }

  function bindEvents() {
    elements.saveBtn.addEventListener('click', saveSettings);
    elements.resetBtn.addEventListener('click', resetDefaults);
    elements.connectBtn.addEventListener('click', connectFlickr);
    elements.disconnectBtn.addEventListener('click', disconnectFlickr);
    elements.backBtn.addEventListener('click', returnToPanel);
    elements.exportBtn.addEventListener('click', exportBackup);
    elements.importBtn.addEventListener('click', openImportPicker);
    elements.importFile.addEventListener('change', importBackupFromFile);
  }

  async function returnToPanel() {
    setStatus('Returning to previous tab...');
    try {
      await sendMessage({ type: 'flickr-meta:return-to-opener-tab' });
      window.close();
    } catch (error) {
      setStatus(`Could not return to previous tab: ${String(error.message || error)}`);
    }
  }

  async function loadSettings() {
    const response = await sendMessage({ type: 'flickr-meta:get-state' });
    const settings = Ext.normalizeSettings(response.settings || {});
    populateForm(settings);
    renderAuthStatus(response.auth || {
      connected: Ext.hasFlickrAuth(settings),
      username: settings.flickrUsername || '',
      fullname: settings.flickrFullname || '',
      nsid: settings.flickrUserNsid || '',
    });
    setStatus('Settings loaded.');
  }

  function populateForm(settings) {
    elements.provider.value = settings.provider;
    elements.preferLocalFirst.checked = Boolean(settings.preferLocalFirst);
    elements.flickrApiKey.value = settings.flickrApiKey || '';
    elements.flickrApiSecret.value = settings.flickrApiSecret || '';
    elements.openaiApiKey.value = settings.openaiApiKey || '';
    elements.openaiModel.value = settings.openaiModel || '';
    elements.deepseekApiKey.value = settings.deepseekApiKey || '';
    elements.deepseekModel.value = settings.deepseekModel || '';
    elements.ollamaBaseUrl.value = settings.ollamaBaseUrl || '';
    elements.ollamaModel.value = settings.ollamaModel || '';
  }

  async function saveSettings() {
    const response = await sendMessage({ type: 'flickr-meta:get-state' });
    const existing = Ext.normalizeSettings(response.settings || {});
    const settings = Ext.normalizeSettings({
      flickrApiKey: elements.flickrApiKey.value.trim(),
      flickrApiSecret: elements.flickrApiSecret.value.trim(),
      flickrAccessToken: existing.flickrAccessToken || '',
      flickrAccessTokenSecret: existing.flickrAccessTokenSecret || '',
      flickrUserNsid: existing.flickrUserNsid || '',
      flickrUsername: existing.flickrUsername || '',
      flickrFullname: existing.flickrFullname || '',
      provider: elements.provider.value,
      preferLocalFirst: elements.preferLocalFirst.checked,
      openaiApiKey: elements.openaiApiKey.value.trim(),
      openaiModel: elements.openaiModel.value.trim(),
      deepseekApiKey: elements.deepseekApiKey.value.trim(),
      deepseekModel: elements.deepseekModel.value.trim(),
      ollamaBaseUrl: elements.ollamaBaseUrl.value.trim(),
      ollamaModel: elements.ollamaModel.value.trim(),
    });

    await sendMessage({
      type: 'flickr-meta:save-settings',
      settings,
    });

    setStatus('Settings saved locally.');
  }

  async function exportBackup() {
    setStatus('Preparing backup...');
    try {
      const response = await sendMessage({ type: 'flickr-meta:get-state' });
      const backup = {
        schemaVersion: 1,
        app: 'flickr-metadata-assistant',
        exportedAt: new Date().toISOString(),
        settings: response.settings || {},
        drafts: response.drafts || {},
        lastContext: response.lastContext || null,
        lastDraft: response.lastDraft || null,
      };

      downloadJson(`flickr-metadata-assistant-backup-${timestampForFilename()}.json`, backup);
      setStatus('Backup exported.');
    } catch (error) {
      setStatus(`Backup export failed: ${String(error.message || error)}`);
    }
  }

  function openImportPicker() {
    elements.importFile.value = '';
    elements.importFile.click();
  }

  async function importBackupFromFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      return;
    }

    setStatus('Reading backup file...');
    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      const response = await sendMessage({
        type: 'flickr-meta:restore-backup',
        backup,
      });

      await loadSettings();
      renderAuthStatus(response.restored ? {
        connected: Ext.hasFlickrAuth(response.restored.settings || {}),
        username: response.restored.settings?.flickrUsername || '',
        fullname: response.restored.settings?.flickrFullname || '',
        nsid: response.restored.settings?.flickrUserNsid || '',
      } : null);
      setStatus('Backup restored.');
    } catch (error) {
      setStatus(`Backup import failed: ${String(error.message || error)}`);
    } finally {
      elements.importFile.value = '';
    }
  }

  async function connectFlickr() {
    setStatus('Connecting to Flickr...');
    try {
      await saveSettings();
      const response = await sendMessage({ type: 'flickr-meta:connect-flickr' });
      renderAuthStatus(response.auth || null);
      setStatus('Flickr connected.');
    } catch (error) {
      setStatus(`Flickr connection failed: ${String(error.message || error)}`);
    }
  }

  async function disconnectFlickr() {
    try {
      const response = await sendMessage({ type: 'flickr-meta:disconnect-flickr' });
      renderAuthStatus(response.auth || null);
      setStatus('Flickr disconnected.');
    } catch (error) {
      setStatus(`Disconnect failed: ${String(error.message || error)}`);
    }
  }

  async function resetDefaults() {
    populateForm(Ext.normalizeSettings());
    setStatus('Defaults restored. Click Save to apply them.');
  }

  function setStatus(text) {
    elements.statusText.textContent = text;
  }

  function renderAuthStatus(auth) {
    const connected = Boolean(auth && auth.connected);
    if (!connected) {
      elements.authStatus.textContent = 'Not connected.';
      return;
    }

    const bits = [];
    if (auth.username) {
      bits.push(`@${auth.username}`);
    }
    if (auth.fullname) {
      bits.push(auth.fullname);
    }
    if (auth.nsid) {
      bits.push(auth.nsid);
    }

    elements.authStatus.textContent = bits.length ? `Connected as ${bits.join(' · ')}` : 'Connected.';
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function timestampForFilename() {
    return new Date().toISOString().replace(/[:]/g, '-').replace(/\..+$/, 'Z');
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
