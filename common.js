(function () {
  const DEFAULT_SETTINGS = {
    provider: 'local',
    openaiApiKey: '',
    openaiModel: 'gpt-4.1-mini',
    deepseekApiKey: '',
    deepseekModel: 'deepseek-v4-flash',
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: 'llama3.2-vision',
    preferLocalFirst: true,
    flickrApiKey: '',
    flickrApiSecret: '',
    flickrAccessToken: '',
    flickrAccessTokenSecret: '',
    flickrUserNsid: '',
    flickrUsername: '',
    flickrFullname: '',
  };

  const STOP_WORDS = new Set([
    'and', 'the', 'with', 'photo', 'image', 'flickr', 'taken', 'capture', 'captured',
    'description', 'title', 'untitled', 'original', 'working', 'terms', 'suggested',
    'version', 'resolution', 'unit', 'inches', 'software', 'date', 'time', 'modified',
    'host', 'computer', 'tile', 'width', 'height', 'null', 'none', 'unknown', 'placeholder',
    'na', 'n_a', 'jfifversion', 'exif', 'xmp', 'creator', 'tool', 'centered',
  ]);

  function normalizeSettings(input = {}) {
    return {
      ...DEFAULT_SETTINGS,
      ...input,
      provider: normalizeProvider(input.provider),
      preferLocalFirst: Boolean(input.preferLocalFirst ?? true),
    };
  }

  function hasFlickrAuth(settings = {}) {
    const normalized = normalizeSettings(settings);
    return Boolean(
      normalized.flickrApiKey &&
      normalized.flickrApiSecret &&
      normalized.flickrAccessToken &&
      normalized.flickrAccessTokenSecret
    );
  }

  function normalizeProvider(provider) {
    const value = String(provider || '').trim().toLowerCase();
    return ['auto', 'local', 'openai', 'deepseek', 'heuristic'].includes(value) ? value : 'local';
  }

  function extractPhotoId(url) {
    const match = String(url || '').match(/\/photos\/[^/]+\/(\d+)/);
    return match ? match[1] : '';
  }

  function formatTags(tags) {
    const clean = [];
    const seen = new Set();

    for (const tag of tags || []) {
      const raw = String(tag || '').trim();
      if (!raw) {
        continue;
      }

      const key = raw.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      clean.push(/\s/.test(raw) ? `"${raw.replace(/"/g, '')}"` : raw);
    }

    return clean.join(' ');
  }

  function cleanTagList(tags, options = {}) {
    const limit = Number.isFinite(options.limit) ? Number(options.limit) : 20;
    const stopWords = new Set([
      ...STOP_WORDS,
      ...((options.stopWords && Array.isArray(options.stopWords)) ? options.stopWords : []),
    ]);
    const clean = [];
    const seen = new Set();

    for (const tag of tags || []) {
      const raw = String(tag || '').trim();
      if (!raw) {
        continue;
      }

      const lowered = raw.toLowerCase();
      if (stopWords.has(lowered)) {
        continue;
      }

      const compact = lowered.replace(/[^a-z0-9]+/g, '');
      if (!compact || compact.length < 2) {
        continue;
      }

      if (seen.has(lowered)) {
        continue;
      }

      seen.add(lowered);
      clean.push(raw);
      if (clean.length >= limit) {
        break;
      }
    }

    return clean;
  }

  function toTitleCase(text) {
    return String(text || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');
  }

  function looksGeneric(text) {
    const value = String(text || '').trim();
    if (!value) {
      return true;
    }

    return /^(img|dsc|photo|untitled|image|p\d+|img_\d+|dsc_\d+|\(?\s*(null|none|unknown)\s*\)?)$/i.test(value);
  }

  function tokenize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }

  function heuristicDraft(context = {}) {
    const tokens = [];
    for (const source of [context.currentTitle, context.pageTitle, context.altText, context.description]) {
      for (const token of tokenize(source)) {
        if (STOP_WORDS.has(token)) {
          continue;
        }
        tokens.push(token);
      }
    }

    const unique = [];
    const seen = new Set();
    for (const token of tokens) {
      if (seen.has(token)) {
        continue;
      }
      seen.add(token);
      unique.push(token);
    }

    const seeded = unique.slice(0, 4);
    const title = !looksGeneric(context.currentTitle) && String(context.currentTitle || '').trim()
      ? toTitleCase(context.currentTitle)
      : seeded.length >= 2
        ? toTitleCase(seeded.join(' '))
        : context.photoId
          ? `Photo ${context.photoId}`
          : 'Untitled photo';

    const description = !looksGeneric(context.description) && String(context.description || '').trim()
      ? String(context.description).trim()
      : context.photoId
        ? `Drafted from Flickr photo ${context.photoId}.`
        : 'Drafted from Flickr page metadata.';

    return {
      title,
      description,
      tags: seeded.slice(0, 12),
      confidence: 'low',
      notes: 'Heuristic draft.',
      source: 'heuristic',
      model: null,
    };
  }

  function normalizeDraft(draft = {}, context = {}, sourceLabel = 'heuristic', model = null) {
    const base = heuristicDraft(context);
    const title = preferDraftText(draft.title, context.currentTitle, base.title);
    const description = preferDraftText(draft.description, context.currentDescription || context.description, base.description);
    const notes = String(draft.notes || '').trim();
    const confidence = ['low', 'medium', 'high'].includes(String(draft.confidence || '').trim())
      ? String(draft.confidence).trim()
      : base.confidence;
    const tags = preferExistingTags(context.currentTags, draft.tags, base.tags);
    const defaultNotes = {
      local: 'Local vision draft.',
      openai: 'OpenAI vision draft.',
      deepseek: 'DeepSeek draft.',
      heuristic: 'Heuristic draft.',
    };

    return {
      title: title || base.title,
      description: description || base.description,
      tags,
      confidence,
      notes: notes || defaultNotes[sourceLabel] || base.notes,
      removeLocation: draft.removeLocation === true,
      source: sourceLabel,
      model,
    };
  }

  function preferDraftText(generated, existing, fallback) {
    const generatedValue = String(generated || '').trim();
    if (generatedValue && !looksGeneric(generatedValue)) {
      return generatedValue;
    }

    const existingValue = String(existing || '').trim();
    if (existingValue && !looksGeneric(existingValue)) {
      return existingValue;
    }

    return String(fallback || '').trim();
  }

  function preferExistingTags(existing, generated, fallback) {
    const existingTags = cleanTagList(splitTags(existing), {
      limit: 18,
      stopWords: ['flickr', 'photo', 'image', 'picture', 'untitled', 'null', 'none', 'unknown'],
    });
    if (existingTags.length) {
      return existingTags;
    }

    const generatedTags = cleanTagList(Array.isArray(generated) ? generated : splitTags(generated), {
      limit: 18,
      stopWords: ['flickr', 'photo', 'image', 'picture', 'untitled', 'null', 'none', 'unknown'],
    });

    if (generatedTags.length) {
      return generatedTags;
    }

    return Array.isArray(fallback) ? fallback.slice() : cleanTagList(splitTags(fallback), {
      limit: 18,
      stopWords: ['flickr', 'photo', 'image', 'picture', 'untitled', 'null', 'none', 'unknown'],
    });
  }

  function splitTags(value) {
    if (Array.isArray(value)) {
      return value;
    }

    return String(value || '')
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function titleFromContext(context = {}) {
    const candidates = [
      context.currentTitle,
      context.pageTitle,
      context.altText,
    ];

    for (const candidate of candidates) {
      const value = String(candidate || '').trim();
      if (value && !looksGeneric(value)) {
        return toTitleCase(value);
      }
    }

    return context.photoId ? `Photo ${context.photoId}` : 'Untitled photo';
  }

  function notesFromError(provider, message) {
    const label = String(provider || 'ai').trim();
    const text = String(message || '').trim();
    return text ? `${label} fallback: ${text}` : `${label} fallback.`;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function buildTextPrompt(context = {}) {
    return [
      'Create Flickr metadata for the attached image.',
      'Keep the title short and natural.',
      'Write a one- or two-sentence description that is concrete and faithful.',
      'Return 6-18 relevant tags, lower-case when reasonable, no duplicates, no location tags.',
      'Context:',
      JSON.stringify({
        title: context.currentTitle || '',
        description: context.description || '',
        tags: context.currentTags || '',
        pageTitle: context.pageTitle || '',
        photoId: context.photoId || '',
        imageUrl: context.imageUrl || '',
        visibility: context.visibility || '',
      }),
    ].join('\n');
  }

  function buildSchema() {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'description', 'tags', 'confidence', 'notes'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 120 },
        description: { type: 'string', minLength: 1, maxLength: 500 },
        tags: {
          type: 'array',
          minItems: 0,
          maxItems: 20,
          items: { type: 'string', minLength: 2, maxLength: 40 },
        },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        notes: { type: 'string', minLength: 1, maxLength: 300 },
      },
    };
  }

  function getFieldValueFromDocument(document, keywords, tagNames = ['input', 'textarea', '[contenteditable="true"]']) {
    const elements = Array.from(document.querySelectorAll(tagNames.join(',')));
    const lowered = keywords.map((item) => String(item).toLowerCase());

    let best = null;
    let bestScore = 0;

    for (const el of elements) {
      const textBits = [
        el.name,
        el.id,
        el.getAttribute('placeholder'),
        el.getAttribute('aria-label'),
        el.getAttribute('data-testid'),
        el.getAttribute('role'),
      ].filter(Boolean).map((item) => String(item).toLowerCase());

      const label = el.labels && el.labels.length ? Array.from(el.labels).map((item) => item.textContent || '').join(' ').toLowerCase() : '';
      const haystack = [...textBits, label].join(' ');
      let score = 0;
      for (const kw of lowered) {
        if (haystack.includes(kw)) {
          score += 2;
        }
      }

      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }

    return best;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  globalThis.FlickrMetaExtension = {
    DEFAULT_SETTINGS,
    normalizeSettings,
    normalizeProvider,
    hasFlickrAuth,
    extractPhotoId,
    formatTags,
    heuristicDraft,
    escapeHtml,
    buildTextPrompt,
    buildSchema,
    cleanTagList,
    normalizeDraft,
    titleFromContext,
    notesFromError,
    getFieldValueFromDocument,
    sleep,
  };
})();
