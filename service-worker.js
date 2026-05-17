importScripts('common.js');

const Ext = globalThis.FlickrMetaExtension;

const STORAGE_KEYS = {
  settings: 'flickrMetaSettings',
  drafts: 'flickrMetaDrafts',
  lastContext: 'flickrMetaLastContext',
  lastDraft: 'flickrMetaLastDraft',
  openerTab: 'flickrMetaOpenerTab',
};

chrome.runtime.onInstalled.addListener(() => {
  ensureDefaults().catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  ensureDefaults().catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    return;
  }

  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));

  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'flickr-meta:get-state':
      return getState();
    case 'flickr-meta:save-settings':
      return { settings: await saveSettings(message.settings || {}) };
    case 'flickr-meta:restore-backup':
      return { restored: await restoreBackup(message.backup || {}) };
    case 'flickr-meta:connect-flickr':
      return { auth: await connectFlickr() };
    case 'flickr-meta:disconnect-flickr':
      return { auth: await disconnectFlickr() };
    case 'flickr-meta:open-popup':
      return { opened: await openPopupWindow() };
    case 'flickr-meta:remember-opener-tab':
      await rememberOpenerTab(message.tab || null);
      return { remembered: true };
    case 'flickr-meta:return-to-opener-tab':
      return { returned: await returnToOpenerTab() };
    case 'flickr-meta:collect-context': {
      const tabId = await resolveTabId(message.tabId, sender);
      const context = await collectContext(tabId);
      await saveLastContext(context);
      return { context };
    }
    case 'flickr-meta:photo-ownership':
      return { ownership: await getPhotoOwnership(message.photoId || '') };
    case 'flickr-meta:generate-draft': {
      const context = message.context || await collectContext(await resolveTabId(message.tabId, sender));
      const settings = await getSettings();
      const draft = await generateDraft(context, settings);
      await saveDraft(context.photoId || 'unknown', {
        photoId: context.photoId || '',
        context,
        draft,
        updatedAt: new Date().toISOString(),
      });
      return { context, draft };
    }
    case 'flickr-meta:publish-draft': {
      const draft = message.draft || (await getLastDraft())?.draft || null;
      if (!draft) {
        throw new Error('No draft available to publish.');
      }

      const publishResult = await publishDraft(message.context || draft.context || null, draft, {
        removeLocation: message.removeLocation !== false,
      });
      await saveDraft(draft.photoId || 'unknown', {
        photoId: draft.photoId || '',
        context: message.context || draft.context || null,
        draft,
        updatedAt: new Date().toISOString(),
        publishedAt: new Date().toISOString(),
        publishResult,
      });
      return publishResult;
    }
    case 'flickr-meta:get-last-draft':
      return { draft: await getLastDraft() };
    case 'flickr-meta:clear-last-draft':
      await chrome.storage.local.remove(STORAGE_KEYS.lastDraft);
      return { cleared: true };
    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

async function ensureDefaults() {
  const { [STORAGE_KEYS.settings]: settings } = await chrome.storage.local.get(STORAGE_KEYS.settings);
  if (!settings) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: Ext.normalizeSettings(),
    });
  }
}

async function openPopupWindow() {
  try {
    if (chrome.action && typeof chrome.action.openPopup === 'function') {
      await chrome.action.openPopup();
      return true;
    }
  } catch {
    // Fallback below.
  }

  await chrome.tabs.create({
    url: chrome.runtime.getURL('popup.html'),
  });
  return true;
}

async function rememberOpenerTab(tab) {
  if (!tab || !Number.isFinite(tab.id)) {
    return;
  }

  await chrome.storage.session.set({
    [STORAGE_KEYS.openerTab]: {
      tabId: tab.id,
      windowId: Number.isFinite(tab.windowId) ? tab.windowId : null,
      url: String(tab.url || ''),
      title: String(tab.title || ''),
      rememberedAt: new Date().toISOString(),
    },
  });
}

async function returnToOpenerTab() {
  const { [STORAGE_KEYS.openerTab]: opener } = await chrome.storage.session.get(STORAGE_KEYS.openerTab);
  if (!opener || !Number.isFinite(opener.tabId)) {
    throw new Error('No previous tab stored.');
  }

  try {
    await chrome.tabs.update(opener.tabId, { active: true });
    if (Number.isFinite(opener.windowId)) {
      await chrome.windows.update(opener.windowId, { focused: true });
    }
  } catch (error) {
    throw new Error(`Could not activate previous tab: ${String(error?.message || error)}`);
  }

  return true;
}

async function getState() {
  const store = await chrome.storage.local.get([
    STORAGE_KEYS.settings,
    STORAGE_KEYS.drafts,
    STORAGE_KEYS.lastContext,
    STORAGE_KEYS.lastDraft,
  ]);
  const settings = Ext.normalizeSettings(store[STORAGE_KEYS.settings] || {});

  return {
    settings,
    auth: getAuthState(settings),
    drafts: store[STORAGE_KEYS.drafts] || {},
    lastContext: store[STORAGE_KEYS.lastContext] || null,
    lastDraft: store[STORAGE_KEYS.lastDraft] || null,
  };
}

async function getSettings() {
  const { [STORAGE_KEYS.settings]: settings } = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return Ext.normalizeSettings(settings || {});
}

async function saveSettings(partial) {
  const current = await getSettings();
  const next = Ext.normalizeSettings({
    ...current,
    ...partial,
  });

  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: next,
  });

  return next;
}

async function saveLastContext(context) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.lastContext]: context,
  });
}

async function saveDraft(photoId, record) {
  const { [STORAGE_KEYS.drafts]: drafts = {} } = await chrome.storage.local.get(STORAGE_KEYS.drafts);
  drafts[String(photoId)] = record;
  await chrome.storage.local.set({
    [STORAGE_KEYS.drafts]: drafts,
    [STORAGE_KEYS.lastDraft]: record,
  });
}

async function restoreBackup(backup) {
  const parsed = normalizeBackup(backup);
  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: parsed.settings,
  });

  const operations = {};
  if (parsed.hasDrafts) {
    operations[STORAGE_KEYS.drafts] = parsed.drafts;
  }

  if (parsed.lastContext) {
    operations[STORAGE_KEYS.lastContext] = parsed.lastContext;
  } else if (parsed.hasLastContext) {
    // Explicitly clear the key when the backup says it should be absent.
    await chrome.storage.local.remove(STORAGE_KEYS.lastContext);
  }

  if (parsed.lastDraft) {
    operations[STORAGE_KEYS.lastDraft] = parsed.lastDraft;
  } else if (parsed.hasLastDraft) {
    await chrome.storage.local.remove(STORAGE_KEYS.lastDraft);
  }

  if (Object.keys(operations).length) {
    await chrome.storage.local.set(operations);
  }

  return {
    settings: parsed.settings,
    drafts: parsed.hasDrafts ? parsed.drafts : {},
    lastContext: parsed.hasLastContext ? parsed.lastContext : null,
    lastDraft: parsed.hasLastDraft ? parsed.lastDraft : null,
  };
}

function normalizeBackup(backup) {
  const source = backup && typeof backup === 'object' ? backup : {};
  const settings = Ext.normalizeSettings(extractBackupSettings(source));
  const hasDrafts = Object.prototype.hasOwnProperty.call(source, 'drafts');
  const drafts = hasDrafts ? normalizeDraftMap(source.drafts) : {};
  const hasLastContext = Object.prototype.hasOwnProperty.call(source, 'lastContext');
  const hasLastDraft = Object.prototype.hasOwnProperty.call(source, 'lastDraft');
  const lastDraft = hasLastDraft
    ? normalizeDraftRecord(source.lastDraft, source.lastDraft?.photoId || '')
    : (hasDrafts ? latestDraftRecord(drafts) : null);
  const lastContext = hasLastContext
    ? source.lastContext || null
    : (lastDraft && lastDraft.context ? lastDraft.context : null);

  return {
    settings,
    drafts,
    hasDrafts,
    hasLastContext,
    hasLastDraft,
    lastContext,
    lastDraft,
  };
}

function extractBackupSettings(source) {
  if (source && typeof source.settings === 'object' && !Array.isArray(source.settings)) {
    return source.settings;
  }

  const candidate = {};
  let matched = false;
  for (const key of Object.keys(Ext.DEFAULT_SETTINGS)) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      candidate[key] = source[key];
      matched = true;
    }
  }

  return matched ? candidate : {};
}

function normalizeDraftMap(drafts) {
  if (!drafts || typeof drafts !== 'object' || Array.isArray(drafts)) {
    return {};
  }

  const clean = {};
  for (const [photoId, record] of Object.entries(drafts)) {
    const normalized = normalizeDraftRecord(record, photoId);
    if (normalized) {
      clean[String(photoId)] = normalized;
    }
  }

  return clean;
}

function normalizeDraftRecord(record, photoId) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return null;
  }

  const copy = { ...record };
  copy.photoId = String(copy.photoId || photoId || '').trim();
  return copy;
}

function latestDraftRecord(drafts) {
  const records = Object.values(drafts || {});
  if (!records.length) {
    return null;
  }

  return records.reduce((latest, current) => {
    if (!latest) {
      return current;
    }

    const latestTime = new Date(latest.updatedAt || latest.publishedAt || 0).getTime();
    const currentTime = new Date(current.updatedAt || current.publishedAt || 0).getTime();
    return currentTime >= latestTime ? current : latest;
  }, null);
}

async function getLastDraft() {
  const { [STORAGE_KEYS.lastDraft]: draft } = await chrome.storage.local.get(STORAGE_KEYS.lastDraft);
  return draft || null;
}

async function resolveTabId(tabId, sender) {
  if (Number.isFinite(tabId)) {
    return tabId;
  }

  if (sender && sender.tab && Number.isFinite(sender.tab.id)) {
    return sender.tab.id;
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const active = tabs[0];
  if (!active || !Number.isFinite(active.id)) {
    throw new Error('No active tab found.');
  }

  return active.id;
}

async function collectContext(tabId) {
  const response = await sendToTab(tabId, { type: 'flickr-meta:collect-context' });
  if (!response || !response.ok) {
    throw new Error(response?.error || 'Unable to collect page context.');
  }

  return response.context;
}

async function getPhotoOwnership(photoId) {
  const settings = await getSettings();
  if (!Ext.hasFlickrAuth(settings)) {
    return {
      canEditPhoto: false,
      reason: 'Flickr is not connected.',
      photoId: String(photoId || ''),
    };
  }

  const info = await getFlickrPhotoInfo(String(photoId || '').trim(), settings);
  const photo = info.photo || {};
  const owner = photo.owner && typeof photo.owner === 'object' ? photo.owner : {};
  const ownerNsid = String(owner.nsid || '').trim();
  const ownerUsername = String(owner.username || '').trim();
  const currentNsid = String(settings.flickrUserNsid || '').trim();
  const currentUsername = String(settings.flickrUsername || '').trim();
  const canEditPhoto = Boolean(
    ownerNsid &&
    currentNsid &&
    ownerNsid === currentNsid
  ) || Boolean(
    ownerUsername &&
    currentUsername &&
    ownerUsername.toLowerCase() === currentUsername.toLowerCase()
  );

  return {
    canEditPhoto,
    photoId: String(photoId || ''),
    ownerNsid,
    ownerUsername,
    currentNsid,
    currentUsername,
    photoUrl: extractPhotoPageUrl(photo, null),
  };
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response);
    });
  });
}

async function generateDraft(context, settings) {
  const preference = Ext.normalizeProvider(settings.provider);
  const order = buildProviderOrder(preference, Boolean(settings.preferLocalFirst));
  const failures = [];

  for (const provider of order) {
    try {
      if (provider === 'heuristic') {
        const draft = Ext.normalizeDraft(Ext.heuristicDraft(context), context, 'heuristic', null);
        if (failures.length) {
          draft.notes = failures[0];
        }
        return draft;
      }

      const draft = await draftWithProvider(provider, context, settings);
      return draft;
    } catch (error) {
      failures.push(formatFailure(provider, error));
    }
  }

  const draft = Ext.normalizeDraft(Ext.heuristicDraft(context), context, 'heuristic', null);
  draft.notes = failures[0] || 'No AI provider was available.';
  return draft;
}

function buildProviderOrder(preference, preferLocalFirst) {
  const fallbackOrder = preferLocalFirst
    ? ['local', 'openai', 'deepseek', 'heuristic']
    : ['openai', 'deepseek', 'local', 'heuristic'];

  switch (preference) {
    case 'local':
      return ['local', 'openai', 'deepseek', 'heuristic'];
    case 'openai':
      return ['openai', 'local', 'deepseek', 'heuristic'];
    case 'deepseek':
      return ['deepseek', 'local', 'openai', 'heuristic'];
    case 'heuristic':
      return ['heuristic'];
    default:
      return fallbackOrder;
  }
}

function formatFailure(provider, error) {
  const message = String(error?.message || error || 'Unknown failure');
  return `${provider} failed: ${message}`;
}

async function draftWithProvider(provider, context, settings) {
  switch (provider) {
    case 'local':
      return draftWithLocalVision(context, settings);
    case 'openai':
      return draftWithOpenAI(context, settings);
    case 'deepseek':
      return draftWithDeepSeek(context, settings);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

async function draftWithLocalVision(context, settings) {
  const baseUrl = String(settings.ollamaBaseUrl || Ext.DEFAULT_SETTINGS.ollamaBaseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const model = String(settings.ollamaModel || Ext.DEFAULT_SETTINGS.ollamaModel || '').trim();

  if (!model) {
    throw new Error('Missing Ollama model.');
  }

  if (!context.imageUrl) {
    throw new Error('No image URL available for local vision.');
  }

  const imageBytes = await fetchImageAsBase64(context.imageUrl);
  const payload = {
    model,
    messages: [
      {
        role: 'system',
        content: 'You generate concise, faithful Flickr metadata from an image and a small amount of existing metadata. Return only valid JSON with keys title, description, tags, confidence, notes. Prefer concrete visual facts over invented details. Do not mention location, GPS coordinates, or privacy status.',
      },
      {
        role: 'user',
        content: Ext.buildTextPrompt(context),
        images: [imageBytes],
      },
    ],
    format: Ext.buildSchema(),
    stream: false,
    options: {
      temperature: 0.3,
    },
  };

  const response = await requestJson(`${baseUrl}/api/chat`, payload);
  const content = extractOllamaContent(response);
  const decoded = JSON.parse(content);
  return Ext.normalizeDraft(decoded, context, 'local', model);
}

async function draftWithOpenAI(context, settings) {
  const apiKey = String(settings.openaiApiKey || '').trim();
  if (!apiKey) {
    throw new Error('Missing OpenAI API key.');
  }

  const model = String(settings.openaiModel || Ext.DEFAULT_SETTINGS.openaiModel || 'gpt-4.1-mini').trim();
  const userContent = [
    {
      type: 'input_text',
      text: Ext.buildTextPrompt(context),
    },
  ];

  if (context.imageUrl) {
    userContent.push({
      type: 'input_image',
      image_url: context.imageUrl,
      detail: 'low',
    });
  }

  const payload = {
    model,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: 'You generate concise, faithful Flickr metadata from an image and a small amount of existing metadata. Return only valid JSON that matches the provided schema. Prefer concrete visual facts over invented details. Do not mention location, GPS coordinates, or privacy status.',
          },
        ],
      },
      {
        role: 'user',
        content: userContent,
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'flickr_photo_metadata',
        strict: true,
        schema: Ext.buildSchema(),
      },
    },
    max_output_tokens: 500,
  };

  const response = await requestJson('https://api.openai.com/v1/responses', payload, {
    Authorization: `Bearer ${apiKey}`,
  });
  const jsonText = extractOpenAIContent(response);
  const decoded = JSON.parse(jsonText);
  return Ext.normalizeDraft(decoded, context, 'openai', model);
}

async function draftWithDeepSeek(context, settings) {
  const apiKey = String(settings.deepseekApiKey || '').trim();
  if (!apiKey) {
    throw new Error('Missing DeepSeek API key.');
  }

  const model = String(settings.deepseekModel || Ext.DEFAULT_SETTINGS.deepseekModel || 'deepseek-v4-flash').trim();
  const payload = {
    model,
    messages: [
      {
        role: 'system',
        content: 'You generate concise, faithful Flickr metadata from existing text metadata only. Return only valid JSON with keys title, description, tags, confidence, notes. Prefer concrete facts over invented details. Do not mention location, GPS coordinates, or privacy status.',
      },
      {
        role: 'user',
        content: Ext.buildTextPrompt(context),
      },
    ],
    response_format: {
      type: 'json_object',
    },
    temperature: 0.3,
    max_tokens: 500,
  };

  const response = await requestJson('https://api.deepseek.com/chat/completions', payload, {
    Authorization: `Bearer ${apiKey}`,
  });
  const jsonText = extractDeepSeekContent(response);
  const decoded = JSON.parse(jsonText);
  return Ext.normalizeDraft(decoded, context, 'deepseek', model);
}

async function requestJson(url, payload, extraHeaders = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let decoded = {};
  if (text) {
    try {
      decoded = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON response from ${url}.`);
    }
  }

  if (!response.ok) {
    const message = decoded?.error?.message || decoded?.error || decoded?.message || `Request failed with status ${response.status}.`;
    throw new Error(String(message));
  }

  return decoded;
}

function extractOpenAIContent(response) {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text;
  }

  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    if (item.type !== 'message' || !Array.isArray(item.content)) {
      continue;
    }
    for (const chunk of item.content) {
      if (chunk && typeof chunk === 'object' && chunk.type === 'output_text' && typeof chunk.text === 'string') {
        return chunk.text;
      }
    }
  }

  throw new Error('OpenAI response did not contain output text.');
}

function extractDeepSeekContent(response) {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const choice = choices[0];
  const content = choice && choice.message && choice.message.content;
  if (typeof content === 'string' && content.trim()) {
    return content;
  }

  throw new Error('DeepSeek response did not contain message content.');
}

function extractOllamaContent(response) {
  const message = response && response.message;
  const content = message && message.content;
  if (typeof content === 'string' && content.trim()) {
    return content;
  }

  throw new Error('Local vision response did not contain message content.');
}

async function fetchImageAsBase64(imageUrl) {
  const response = await fetch(imageUrl, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`Failed to download image (${response.status}).`);
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode.apply(null, slice);
  }

  return btoa(binary);
}

function getAuthState(settings) {
  const connected = Ext.hasFlickrAuth(settings);
  return {
    connected,
    username: settings.flickrUsername || '',
    fullname: settings.flickrFullname || '',
    nsid: settings.flickrUserNsid || '',
  };
}

async function connectFlickr() {
  const settings = await getSettings();
  if (!settings.flickrApiKey || !settings.flickrApiSecret) {
    throw new Error('Set the Flickr API key and secret first.');
  }

  const redirectUri = chrome.identity.getRedirectURL('flickr');
  const requestToken = await getOAuthRequestToken(settings, redirectUri);
  const authorizeUrl = new URL('https://www.flickr.com/services/oauth/authorize');
  authorizeUrl.searchParams.set('oauth_token', requestToken.oauth_token);
  authorizeUrl.searchParams.set('perms', 'write');

  const callbackUrl = await chrome.identity.launchWebAuthFlow({
    url: authorizeUrl.toString(),
    interactive: true,
  });

  if (!callbackUrl) {
    throw new Error('Flickr authorization was cancelled.');
  }

  const callbackParams = new URL(callbackUrl).searchParams;
  const oauthToken = callbackParams.get('oauth_token') || '';
  const oauthVerifier = callbackParams.get('oauth_verifier') || '';
  if (!oauthToken || !oauthVerifier) {
    throw new Error('Flickr did not return an authorization verifier.');
  }

  const accessToken = await getOAuthAccessToken(settings, requestToken.oauth_token_secret, oauthToken, oauthVerifier);
  const next = Ext.normalizeSettings({
    ...settings,
    flickrAccessToken: accessToken.oauth_token || '',
    flickrAccessTokenSecret: accessToken.oauth_token_secret || '',
    flickrUserNsid: accessToken.user_nsid || '',
    flickrUsername: accessToken.username || '',
    flickrFullname: accessToken.fullname || '',
  });

  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: next,
  });

  return getAuthState(next);
}

async function disconnectFlickr() {
  const settings = await getSettings();
  const next = Ext.normalizeSettings({
    ...settings,
    flickrAccessToken: '',
    flickrAccessTokenSecret: '',
    flickrUserNsid: '',
    flickrUsername: '',
    flickrFullname: '',
  });

  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: next,
  });

  return getAuthState(next);
}

async function publishDraft(context, draft, options = {}) {
  const settings = await getSettings();
  if (!Ext.hasFlickrAuth(settings)) {
    throw new Error('Connect Flickr before publishing.');
  }

  const photoId = String(draft.photoId || context?.photoId || '').trim();
  if (!photoId) {
    throw new Error('Missing photo id.');
  }

  const info = await getFlickrPhotoInfo(photoId, settings);
  const livePhoto = info.photo || {};
  const liveVisibility = normalizeLiveVisibility(livePhoto.visibility || {});
  const title = String(draft.title || '').trim();
  const description = String(draft.description || '').trim();
  const tagList = mergeTagLists(extractFlickrTags(livePhoto.tags || {}), Array.isArray(draft.tags) ? draft.tags : []);
  const removeLocation = options.removeLocation !== false;

  await flickrApiRequest('flickr.photos.setMeta', {
    photo_id: photoId,
    title,
    description,
  }, settings, { method: 'POST', auth: true });

  if (tagList.length) {
    await flickrApiRequest('flickr.photos.addTags', {
      photo_id: photoId,
      tags: Ext.formatTags(tagList),
    }, settings, { method: 'POST', auth: true });
  }

  if (removeLocation) {
    try {
      await flickrApiRequest('flickr.photos.geo.removeLocation', {
        photo_id: photoId,
      }, settings, { method: 'POST', auth: true });
    } catch (error) {
      const message = String(error?.message || error || '');
      if (!/not geotagged|no geodata|no location/i.test(message)) {
        throw error;
      }
    }
  }

  let published = false;
  if (liveVisibility.ispublic === 0 && liveVisibility.isfriend === 0 && liveVisibility.isfamily === 0) {
    await flickrApiRequest('flickr.photos.setPerms', {
      photo_id: photoId,
      is_public: 1,
      is_friend: 0,
      is_family: 0,
    }, settings, { method: 'POST', auth: true });
    published = true;
  }

  return {
    photoId,
    published,
    visibility: published ? 'public' : visibilityLabel(liveVisibility),
    photoUrl: extractPhotoPageUrl(livePhoto, context),
  };
}

async function getFlickrPhotoInfo(photoId, settings) {
  const response = await flickrApiRequest('flickr.photos.getInfo', {
    photo_id: photoId,
  }, settings, { method: 'GET', auth: true });

  if (!response || !response.photo) {
    throw new Error('Flickr photo info response was incomplete.');
  }

  return response;
}

function normalizeLiveVisibility(visibility = {}) {
  return {
    ispublic: Number(visibility.ispublic || 0),
    isfriend: Number(visibility.isfriend || 0),
    isfamily: Number(visibility.isfamily || 0),
  };
}

function visibilityLabel(visibility = {}) {
  const parts = [];
  if (Number(visibility.ispublic || 0) === 1) {
    parts.push('public');
  } else {
    parts.push('private');
    if (Number(visibility.isfriend || 0) === 1) {
      parts.push('friends');
    }
    if (Number(visibility.isfamily || 0) === 1) {
      parts.push('family');
    }
  }

  return parts.join(' + ');
}

function extractPhotoPageUrl(photo, context) {
  const urls = photo && photo.urls && Array.isArray(photo.urls.url) ? photo.urls.url : [];
  for (const url of urls) {
    const value = url && typeof url === 'object' ? String(url._content || '').trim() : '';
    if (value) {
      return value;
    }
  }

  const owner = photo && photo.owner && typeof photo.owner === 'object' ? photo.owner : {};
  const pathAlias = String(owner.pathalias || '').trim();
  const ownerName = String(owner.username || '').trim();
  const user = pathAlias || ownerName;
  if (user && photo && photo.id) {
    return `https://www.flickr.com/photos/${encodeURIComponent(user)}/${photo.id}/`;
  }

  if (context && context.photoPageUrl) {
    return String(context.photoPageUrl);
  }

  return '';
}

function extractFlickrTags(tags = {}) {
  const list = Array.isArray(tags.tag) ? tags.tag : [];
  return list
    .map((tag) => String(tag.raw || tag._content || tag.text || '').trim())
    .filter(Boolean);
}

function mergeTagLists(existing, incoming) {
  const merged = [];
  const seen = new Set();
  const combined = [...(existing || []), ...(incoming || [])];

  for (const tag of combined) {
    const raw = String(tag || '').trim();
    if (!raw) {
      continue;
    }

    const key = raw.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(raw);
  }

  return Ext.cleanTagList(merged, {
    limit: 20,
    stopWords: ['flickr', 'photo', 'image', 'picture', 'untitled', 'null', 'none', 'unknown'],
  });
}

async function flickrApiRequest(methodName, params, settings, options = {}) {
  const httpMethod = String(options.method || 'GET').toUpperCase();
  const authRequired = Boolean(options.auth);
  const apiKey = String(settings.flickrApiKey || '').trim();
  const apiSecret = String(settings.flickrApiSecret || '').trim();
  const token = String(settings.flickrAccessToken || '').trim();
  const tokenSecret = String(settings.flickrAccessTokenSecret || '').trim();

  if (!apiKey || !apiSecret) {
    throw new Error('Missing Flickr API credentials.');
  }

  if (authRequired && (!token || !tokenSecret)) {
    throw new Error('Missing Flickr access token.');
  }

  const requestParams = {
    method: methodName,
    api_key: apiKey,
    format: 'json',
    nojsoncallback: '1',
    ...params,
  };

  const oauthParams = buildOAuthParams(apiKey, token || undefined);
  if (authRequired && token) {
    oauthParams.oauth_token = token;
  }

  const allParams = {
    ...requestParams,
    ...oauthParams,
  };

  const signature = await signOAuthRequest(httpMethod, 'https://api.flickr.com/services/rest', allParams, apiSecret, tokenSecret);
  oauthParams.oauth_signature = signature;

  const finalParams = {
    ...requestParams,
    ...oauthParams,
  };

  const url = 'https://api.flickr.com/services/rest';
  if (httpMethod === 'GET') {
    const query = toQueryString(finalParams);
    const response = await fetch(`${url}?${query}`);
    const text = await response.text();
    return parseFlickrJsonResponse(text, response.status);
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: toQueryString(finalParams),
  });
  const text = await response.text();
  return parseFlickrJsonResponse(text, response.status);
}

async function getOAuthRequestToken(settings, callbackUrl) {
  const apiKey = String(settings.flickrApiKey || '').trim();
  const apiSecret = String(settings.flickrApiSecret || '').trim();
  const params = {
    oauth_callback: callbackUrl,
  };
  const oauthParams = buildOAuthParams(apiKey);
  const allParams = { ...params, ...oauthParams };
  const signature = await signOAuthRequest('GET', 'https://www.flickr.com/services/oauth/request_token', allParams, apiSecret, '');
  const finalParams = { ...allParams, oauth_signature: signature };
  const url = `https://www.flickr.com/services/oauth/request_token?${toQueryString(finalParams)}`;
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(parseOAuthError(text, response.status));
  }
  return parseQueryResponse(text);
}

async function getOAuthAccessToken(settings, requestTokenSecret, oauthToken, verifier) {
  const apiKey = String(settings.flickrApiKey || '').trim();
  const apiSecret = String(settings.flickrApiSecret || '').trim();
  const params = {
    oauth_verifier: verifier,
    oauth_token: oauthToken,
  };
  const oauthParams = buildOAuthParams(apiKey, oauthToken);
  const allParams = { ...params, ...oauthParams };
  const signature = await signOAuthRequest('GET', 'https://www.flickr.com/services/oauth/access_token', allParams, apiSecret, requestTokenSecret);
  const finalParams = { ...allParams, oauth_signature: signature };
  const url = `https://www.flickr.com/services/oauth/access_token?${toQueryString(finalParams)}`;
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(parseOAuthError(text, response.status));
  }
  return parseQueryResponse(text);
}

function buildOAuthParams(consumerKey, token = '') {
  const params = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: randomNonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: '1.0',
  };

  if (token) {
    params.oauth_token = token;
  }

  return params;
}

async function signOAuthRequest(method, url, params, consumerSecret, tokenSecret) {
  const normalized = normalizeOAuthParams(params);
  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(buildParameterString(normalized)),
  ].join('&');
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret || '')}`;
  return hmacSha1Base64(signingKey, baseString);
}

function normalizeOAuthParams(params) {
  return Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null)
    .sort()
    .map((key) => [percentEncode(key), percentEncode(String(params[key]))]);
}

function buildParameterString(pairs) {
  return pairs
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function toQueryString(params) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    searchParams.set(key, String(value));
  }
  return searchParams.toString();
}

function parseQueryResponse(text) {
  return Object.fromEntries(new URLSearchParams(text));
}

function parseOAuthError(text, status) {
  const params = parseQueryResponse(text);
  if (params.oauth_problem) {
    return `Flickr auth failed: ${params.oauth_problem}`;
  }

  if (params.stat === 'fail' && params.message) {
    return String(params.message);
  }

  return `Flickr auth failed with status ${status}.`;
}

function parseFlickrJsonResponse(text, status) {
  let decoded = {};
  if (text) {
    try {
      decoded = JSON.parse(text);
    } catch {
      throw new Error(`Flickr API returned invalid JSON (${status}).`);
    }
  }

  if (!decoded || typeof decoded !== 'object') {
    throw new Error(`Flickr API returned an invalid response (${status}).`);
  }

  if (status >= 400) {
    const message = decoded.message || decoded.error || decoded.stat || `Flickr API request failed with status ${status}.`;
    throw new Error(String(message));
  }

  if (decoded.stat && decoded.stat !== 'ok') {
    const message = decoded.message || `Flickr API request failed with status ${status}.`;
    throw new Error(String(message));
  }

  return decoded;
}

function randomNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function hmacSha1Base64(key, message) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return base64FromBytes(new Uint8Array(signature));
}

function base64FromBytes(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}
