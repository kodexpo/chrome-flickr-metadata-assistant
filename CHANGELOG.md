# Changelog

All notable changes to Flickr Metadata Assistant are documented here.

## 0.3.2 - 2026-10-18

### Changed

- Group submission now preflights media type, content type, safety level, and geotag restrictions, and explains all documented Flickr pool-submission errors.
- Group errors now appear in a full-width, high-contrast alert instead of being compressed into the group-count header.
- Confirmed memberships now provide a `Leave on Flickr` action without requesting Flickr's broad delete permission.
- Group memberships and recommendations now load automatically whenever the popup opens on an editable Flickr photo.

## 0.3.1 - 2026-10-17

### Added

- Invitation-only group support with a user-editable administrator message sent through Flickr's membership-request API.
- An in-panel request state that distinguishes pending membership invitations from photo-pool submissions.

### Changed

- Privacy disclosures now cover user-authored invitation-request messages sent to Flickr group administrators.
- Invitation requests remain disabled after popup refresh or browser restart and are cleared automatically after Flickr confirms membership.

## 0.3.0 - 2026-09-30

### Added

- Per-photo Flickr group management with approved, locally tracked pending, eligible, and tag-matched suggested states.
- Explicit single-group submit and remove actions with confirmation.
- Group tracking in extension backup and restore files.
- Flickr-wide group discovery using up to three specific photo tags, with discovered groups clearly separated from groups that already accept submissions.
- In-panel joining for discovered public groups, with confirmation and Flickr group-rule handling so opening a separate tab is no longer required for ordinary joins.

### Changed

- Group recommendations now hide unmatched eligible groups and ignore generic tags such as `animal`, `nature`, and `photography`.
- Recommendation matching uses whole words and singular/plural variants to avoid substring-based false positives.
- Unmatched eligible groups are hidden by default but remain available through a Show all eligible toggle.

## 0.2.0 - 2026-09-30

### Added

- Configurable visual interpretation: literal, balanced, or expressive.
- Configurable writing tone: neutral, warm, playful, documentary, or poetic.
- Image understanding through the DeepSeek `deepseek-flash` model.
- Authenticated image retrieval for private Flickr photos before local or cloud captioning.

### Changed

- Explicit provider selections now remain on the selected provider instead of silently switching to another AI provider.
- DeepSeek's response budget was increased to prevent truncated image-analysis results.
- Numeric AI confidence values are converted to low, medium, or high.
- The obsolete `deepseek-v4-flash` setting is migrated to `deepseek-flash`.

### Fixed

- Title and description extraction on non-Pro Flickr photo pages.
- Empty Flickr placeholders are no longer treated as real metadata.
- Private Flickr image URLs no longer need to be downloaded directly by cloud providers, avoiding upstream HTTP 403 errors.
- The launcher remains available on owner-editable photo pages when Flickr is disconnected and now explains how to reconnect.
- Flickr authorization now opens from the visible Options page and reports each connection stage or error beside the connection controls.

## 0.1.0

- Initial Chrome extension release.
