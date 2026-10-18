(function () {
  const Ext = globalThis.FlickrMetaExtension;

  const state = {
    tabId: null,
    context: null,
    draft: null,
    settings: null,
    auth: null,
    groups: null,
    showAllEligible: false,
    groupDialogMode: 'join',
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
    elements.groupsRefreshBtn = document.getElementById('groupsRefreshBtn');
    elements.groupsToggleEligibleBtn = document.getElementById('groupsToggleEligibleBtn');
    elements.groupsSummary = document.getElementById('groupsSummary');
    elements.groupsFeedback = document.getElementById('groupsFeedback');
    elements.groupsList = document.getElementById('groupsList');
    elements.groupJoinDialog = document.getElementById('groupJoinDialog');
    elements.groupJoinTitle = document.getElementById('groupJoinTitle');
    elements.groupJoinDescription = document.getElementById('groupJoinDescription');
    elements.groupJoinRulesWrap = document.getElementById('groupJoinRulesWrap');
    elements.groupJoinRules = document.getElementById('groupJoinRules');
    elements.groupJoinNotice = document.getElementById('groupJoinNotice');
    elements.groupInvitationMessageWrap = document.getElementById('groupInvitationMessageWrap');
    elements.groupInvitationMessage = document.getElementById('groupInvitationMessage');
    elements.groupJoinCancelBtn = document.getElementById('groupJoinCancelBtn');
    elements.groupJoinConfirmBtn = document.getElementById('groupJoinConfirmBtn');
  }

  function bindEvents() {
    elements.refreshBtn.addEventListener('click', () => refresh());
    elements.draftBtn.addEventListener('click', () => generateDraft());
    elements.publishBtn.addEventListener('click', () => publishDraft());
    elements.copyBtn.addEventListener('click', () => copyDraft());
    elements.optionsBtn.addEventListener('click', openOptions);
    elements.groupsRefreshBtn.addEventListener('click', loadGroups);
    elements.groupsToggleEligibleBtn.addEventListener('click', toggleEligibleGroups);
    elements.groupsList.addEventListener('click', handleGroupAction);
    elements.groupJoinCancelBtn.addEventListener('click', () => elements.groupJoinDialog.close('cancel'));
    elements.groupJoinConfirmBtn.addEventListener('click', () => {
      if (state.groupDialogMode === 'invitation' && !elements.groupInvitationMessage.value.trim()) {
        elements.groupJoinNotice.textContent = 'Write a short message for the group administrators.';
        elements.groupInvitationMessage.focus();
        return;
      }
      elements.groupJoinDialog.close('confirm');
    });

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
      renderGroups(null);

      if (!state.context.canEditPhoto) {
        renderDraft(null, true);
        setFooter(
          state.auth && !state.auth.connected
            ? 'Flickr is disconnected. Open Options and connect your Flickr account.'
            : 'This photo is not editable by the connected Flickr account.'
        );
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
      if (state.auth?.connected) {
        void loadGroups();
      }
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

  async function loadGroups() {
    if (!state.context?.photoId || !state.auth?.connected) {
      renderGroups(null, 'Connect Flickr to manage groups.');
      return;
    }

    elements.groupsRefreshBtn.disabled = true;
    elements.groupsRefreshBtn.textContent = 'Refreshing...';
    elements.groupsSummary.textContent = 'Loading approved, pending, and eligible groups...';
    clearGroupsFeedback();
    try {
      const response = await sendMessage({
        type: 'flickr-meta:get-photo-groups',
        photoId: state.context.photoId,
        tags: currentFormDraft().tags,
      });
      state.groups = response.groups;
      renderGroups(state.groups);
    } catch (error) {
      renderGroups(null);
      showGroupsFeedback(`Group refresh failed: ${String(error.message || error)}`);
    } finally {
      elements.groupsRefreshBtn.disabled = false;
      elements.groupsRefreshBtn.textContent = 'Refresh groups';
    }
  }

  async function handleGroupAction(event) {
    const button = event.target.closest('button[data-group-action]');
    if (!button || !state.context?.photoId) {
      return;
    }

    const action = button.dataset.groupAction;
    const groupId = button.dataset.groupId || '';
    const groupName = button.dataset.groupName || groupId;
    if (action === 'leave-on-flickr') {
      const groupUrl = button.dataset.groupUrl || '';
      if (groupUrl) {
        chrome.tabs.create({ url: groupUrl });
      }
      return;
    }
    if (action === 'join') {
      button.disabled = true;
      clearGroupsFeedback();
      elements.groupsSummary.textContent = `Checking ${groupName}...`;
      try {
        const infoResponse = await sendMessage({
          type: 'flickr-meta:get-group-join-info',
          groupId,
        });
        const group = infoResponse.group || {};
        const rules = String(group.rules || '').trim();
        const decision = await confirmGroupJoin({
          name: group.name || groupName,
          description: group.description || '',
          rules,
        });
        if (!decision.confirmed) {
          renderGroups(state.groups);
          return;
        }

        elements.groupsSummary.textContent = `Joining ${groupName}...`;
        const response = await sendMessage({
          type: 'flickr-meta:join-group',
          photoId: state.context.photoId,
          groupId,
          acceptRules: Boolean(rules),
          tags: currentFormDraft().tags,
        });
        if (response.invitationRequired) {
          const invitation = await confirmGroupJoin({
            name: group.name || groupName,
            description: group.description || '',
            rules,
          }, { invitation: true });
          if (!invitation.confirmed) {
            renderGroups(state.groups);
            return;
          }

          elements.groupsSummary.textContent = `Requesting an invitation to ${groupName}...`;
          const requestResponse = await sendMessage({
            type: 'flickr-meta:request-group-invitation',
            photoId: state.context.photoId,
            groupId,
            message: invitation.message,
            acceptRules: true,
            tags: currentFormDraft().tags,
          });
          state.groups = requestResponse.groups;
          renderGroups(state.groups);
          setFooter(`Invitation requested from ${groupName}.`);
          return;
        }
        state.groups = response.groups;
        renderGroups(state.groups);
        setFooter(`Joined ${groupName}. You can now submit this photo to the group.`);
      } catch (error) {
        showGroupsFeedback(`Join failed: ${String(error.message || error)}`);
        button.disabled = false;
      }
      return;
    }
    const verb = action === 'remove' ? 'Remove this photo from' : 'Submit this photo to';
    if (!confirm(`${verb} ${groupName}?`)) {
      return;
    }

    button.disabled = true;
    clearGroupsFeedback();
    elements.groupsSummary.textContent = action === 'remove'
      ? `Removing from ${groupName}...`
      : `Submitting to ${groupName}...`;
    try {
      const response = await sendMessage({
        type: action === 'remove'
          ? 'flickr-meta:remove-photo-from-group'
          : 'flickr-meta:add-photo-to-group',
        photoId: state.context.photoId,
        groupId,
        groupName,
        tags: currentFormDraft().tags,
      });
      state.groups = response.groups;
      renderGroups(state.groups);
    } catch (error) {
      const message = `Group update failed: ${String(error.message || error)}`;
      showGroupsFeedback(message);
      setFooter(message);
      button.disabled = false;
    }
  }

  function showGroupsFeedback(message) {
    elements.groupsFeedback.textContent = message;
    elements.groupsFeedback.classList.remove('hidden');
  }

  function clearGroupsFeedback() {
    elements.groupsFeedback.textContent = '';
    elements.groupsFeedback.classList.add('hidden');
  }

  function confirmGroupJoin(group, options = {}) {
    const invitation = options.invitation === true;
    state.groupDialogMode = invitation ? 'invitation' : 'join';
    elements.groupJoinTitle.textContent = invitation
      ? `Request an invitation to ${group.name}?`
      : `Join ${group.name}?`;
    elements.groupJoinDescription.textContent = group.description || 'Join this Flickr group with the connected account.';
    elements.groupJoinRules.textContent = group.rules || '';
    elements.groupJoinRulesWrap.classList.toggle('hidden', !group.rules);
    elements.groupInvitationMessageWrap.classList.toggle('hidden', !invitation);
    elements.groupInvitationMessage.value = invitation
      ? `Hello, I would like to join ${group.name} and share relevant photos.`
      : '';
    elements.groupJoinConfirmBtn.textContent = invitation ? 'Send request' : 'Join group';
    elements.groupJoinNotice.textContent = invitation
      ? 'This message will be sent to the group administrators through Flickr.'
      : group.rules
        ? 'Joining confirms that you have read and accepted these rules.'
        : 'The group did not return any rules through the Flickr API.';

    return new Promise((resolve) => {
      const handleClose = () => {
        elements.groupJoinDialog.removeEventListener('close', handleClose);
        resolve({
          confirmed: elements.groupJoinDialog.returnValue === 'confirm',
          message: elements.groupInvitationMessage.value.trim(),
        });
      };
      elements.groupJoinDialog.addEventListener('close', handleClose);
      elements.groupJoinDialog.showModal();
    });
  }

  function toggleEligibleGroups() {
    state.showAllEligible = !state.showAllEligible;
    renderGroups(state.groups);
  }

  function renderGroups(groups, message = '') {
    state.groups = groups;
    clearGroupsFeedback();
    if (!groups || !Array.isArray(groups.items)) {
      state.showAllEligible = false;
      elements.groupsToggleEligibleBtn.classList.add('hidden');
      elements.groupsSummary.textContent = message || 'Refresh to inspect this photo\'s groups.';
      elements.groupsList.replaceChildren();
      return;
    }

    const counts = groups.counts || {};
    const hiddenEligible = groups.items.filter((group) => group.status === 'eligible').length;
    elements.groupsSummary.textContent = [
      `${counts.approved || 0} approved`,
      `${counts.pending || 0} pending`,
      `${counts.invitationRequested || 0} invitation requested`,
      `${counts.suggested || 0} suggested`,
      `${counts.discovered || 0} discovered`,
      `${counts.totalEligible || 0} eligible checked`,
      !state.showAllEligible && hiddenEligible ? `${hiddenEligible} hidden` : '',
    ].filter(Boolean).join(' · ');

    elements.groupsToggleEligibleBtn.classList.toggle('hidden', hiddenEligible === 0);
    elements.groupsToggleEligibleBtn.textContent = state.showAllEligible
      ? 'Hide unrelated'
      : `Show all eligible (${hiddenEligible})`;

    const fragment = document.createDocumentFragment();
    for (const group of groups.items) {
      if (group.status === 'eligible' && !state.showAllEligible) {
        continue;
      }
      const row = document.createElement('article');
      row.className = 'group-row';

      const copy = document.createElement('div');
      copy.className = 'group-copy';
      const link = document.createElement('a');
      link.href = group.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = group.name;
      const detail = document.createElement('span');
      detail.className = `group-status status-${group.status}`;
      const statusLabel = group.status === 'membership-requested'
        ? 'Invitation requested'
        : group.status;
      detail.textContent = group.matches?.length
        ? `${statusLabel} · matches ${group.matches.join(', ')}`
        : statusLabel;
      copy.append(link, detail);

      const action = document.createElement('button');
      action.type = 'button';
      action.dataset.groupId = group.id;
      action.dataset.groupName = group.name;
      if (group.status === 'approved') {
        action.dataset.groupAction = 'remove';
        action.textContent = 'Remove';
      } else if (group.status === 'pending') {
        action.disabled = true;
        action.textContent = 'Pending';
      } else if (group.status === 'membership-requested') {
        action.disabled = true;
        action.textContent = 'Requested';
      } else if (group.status === 'discovered') {
        action.dataset.groupAction = 'join';
        action.textContent = 'Join';
      } else {
        action.dataset.groupAction = 'submit';
        action.textContent = 'Submit';
      }

      const actions = document.createElement('div');
      actions.className = 'group-row-actions';
      actions.append(action);

      const isMember = ['approved', 'pending', 'suggested', 'eligible'].includes(group.status);
      if (isMember) {
        const leave = document.createElement('button');
        leave.type = 'button';
        leave.className = 'group-leave-action';
        leave.dataset.groupAction = 'leave-on-flickr';
        leave.dataset.groupId = group.id;
        leave.dataset.groupName = group.name;
        leave.dataset.groupUrl = group.url;
        leave.textContent = 'Leave on Flickr';
        leave.title = 'Open this group on Flickr to leave it safely';
        actions.append(leave);
      }

      row.append(copy, actions);
      fragment.append(row);
    }
    elements.groupsList.replaceChildren(fragment);
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
