import type { CookieOptions } from 'express';

// __Host- makes browsers require Secure, Path=/ and no Domain
export const SESSION_COOKIE = '__Host-session';

// Shared by set and clear: clearCookie only deletes a cookie whose attributes match
export const SESSION_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
};
