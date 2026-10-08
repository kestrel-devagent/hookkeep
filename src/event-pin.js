/**
 * Event pins + notes — shared by the Node server (src/db.js) and Workers (workers/src/worker.js).
 * Pure ESM, zero deps.
 *
 * A pinned event is exempt from the per-inbox keep-window trim (and from bulk delete unless
 * the caller passes includePinned:true), so the one payload you need to debug against does
 * not scroll away when a provider retries 50 times. Pins are bounded per inbox by tier.
 */

export const PIN_LIMITS = { free: 5, paid: 100 };
export const NOTE_MAX = 280;

export function pinLimitFor(tier) {
  return PIN_LIMITS[tier] != null ? PIN_LIMITS[tier] : PIN_LIMITS.free;
}

/**
 * Validate a PATCH /api/events/:id body. Accepts { pinned?: boolean, note?: string|null }.
 * Returns { ok:true, patch } or { ok:false, error, message } — nothing is applied on error.
 */
export function normalizePinPatch(body) {
  const b = body && typeof body === 'object' ? body : {};
  const patch = {};
  if ('pinned' in b) {
    if (typeof b.pinned !== 'boolean') {
      return { ok: false, error: 'bad_pinned', message: 'pinned must be true or false' };
    }
    patch.pinned = b.pinned;
  }
  if ('note' in b) {
    if (b.note === null) patch.note = '';
    else if (typeof b.note !== 'string') {
      return { ok: false, error: 'bad_note', message: 'note must be a string (or null to clear)' };
    } else if (b.note.length > NOTE_MAX) {
      return { ok: false, error: 'bad_note', message: `note must be ≤ ${NOTE_MAX} characters` };
    } else patch.note = b.note.trim();
  }
  if (!('pinned' in patch) && !('note' in patch)) {
    return { ok: false, error: 'empty_patch', message: 'Send pinned and/or note' };
  }
  return { ok: true, patch };
}

/**
 * Apply a normalized patch to an event object in place.
 * pinnedCount = number of OTHER pinned events in the same inbox.
 * Returns { ok:true, event, changedPin } or { ok:false, error:'pin_limit', limit }.
 */
export function applyPinPatch(event, patch, { pinnedCount = 0, limit = PIN_LIMITS.free } = {}) {
  const wasPinned = Boolean(event.pinned);
  if (patch.pinned === true && !wasPinned && pinnedCount >= limit) {
    return {
      ok: false,
      error: 'pin_limit',
      limit,
      message: `This inbox already has ${pinnedCount} pinned events (limit ${limit}). Unpin one first.`,
    };
  }
  if ('pinned' in patch) {
    if (patch.pinned) {
      event.pinned = true;
      if (!wasPinned) event.pinnedAt = new Date().toISOString();
    } else {
      delete event.pinned;
      delete event.pinnedAt;
    }
  }
  if ('note' in patch) {
    if (patch.note) event.note = patch.note;
    else delete event.note;
  }
  return { ok: true, event, changedPin: wasPinned !== Boolean(event.pinned) };
}

/** pinned filter: '1'/'true'/'yes' → pinned only, '0'/'false'/'no' → unpinned only, else no filter. */
export function pinnedFilterMatch(e, pinned) {
  const f = String(pinned == null ? '' : pinned).toLowerCase();
  if (f === '1' || f === 'true' || f === 'yes') return Boolean(e && e.pinned);
  if (f === '0' || f === 'false' || f === 'no') return !(e && e.pinned);
  return true;
}

/**
 * Given rows sorted newest-first, return the ones to delete for a keep window of `keep`.
 * Pinned rows never count toward the window and are never trimmed.
 * isPinned(row) defaults to row.pinned.
 */
export function rowsToTrim(rows, keep, isPinned = (r) => Boolean(r && r.pinned)) {
  const unpinned = rows.filter((r) => !isPinned(r));
  return unpinned.slice(Math.max(0, keep));
}

/** Fields exposed on list/export rows. */
export function publicPinFields(e) {
  return { pinned: Boolean(e && e.pinned), note: (e && e.note) || '' };
}
