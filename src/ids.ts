import { randomUUID } from 'node:crypto';

/** Identyfikator publiczny: przedrostek i 20 znaków szesnastkowych (`msg_…`, `pkg_…`, `in_…`). */
export const shortId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
