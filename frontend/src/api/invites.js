import { apiPost } from './client';

// Event invites (host). Base: /api/events.
// body { invites?: [{ email, name? }], accountIds?: [friendId] }
export const inviteToEvent = (eventId, { invites, accountIds } = {}) =>
  apiPost(`/events/${eventId}/invites`, { invites, accountIds }, { eventId });
