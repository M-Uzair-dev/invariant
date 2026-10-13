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

// CSRF second layer: state-changing session requests must carry this header.
// HTML forms can't set it, and a cross-origin fetch with it needs a preflight we refuse.
export const CSRF_HEADER = 'x-csrf';
export const CSRF_SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
