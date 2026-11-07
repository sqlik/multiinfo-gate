import { describe, expect, it } from 'vitest';
import { isAutomated } from '../../src/links/bots.ts';

const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

describe('isAutomated', () => {
  it('uznaje metodę HEAD za automat', () => {
    expect(isAutomated('HEAD', { 'user-agent': CHROME_ANDROID })).toBe(true);
  });

  it('uznaje nagłówki wstępnego pobierania za automat', () => {
    expect(isAutomated('GET', { 'user-agent': CHROME_ANDROID, purpose: 'prefetch' })).toBe(true);
    expect(isAutomated('GET', { 'user-agent': CHROME_ANDROID, 'sec-purpose': 'prefetch;prerender' })).toBe(true);
    expect(isAutomated('GET', { 'user-agent': SAFARI_IOS, 'x-purpose': 'preview' })).toBe(true);
    expect(isAutomated('GET', { 'user-agent': CHROME_ANDROID, 'x-moz': 'prefetch' })).toBe(true);
  });

  it.each([
    ['podgląd w Wiadomościach Apple', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0'],
    ['WhatsApp', 'WhatsApp/2.23.20.0 A'],
    ['Telegram', 'TelegramBot (like TwitterBot)'],
    ['Slack', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'],
    ['Microsoft Teams', 'Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5'],
    ['Discord', 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'],
    ['LinkedIn', 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)'],
    ['skaner bez przeglądarki', 'python-requests/2.31.0'],
    ['przeglądarka bez okna', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/124.0.0.0 Safari/537.36'],
  ])('uznaje %s za automat', (_name, ua) => {
    expect(isAutomated('GET', { 'user-agent': ua })).toBe(true);
  });

  it('uznaje wejście bez nagłówka User-Agent za automat', () => {
    expect(isAutomated('GET', {})).toBe(true);
    expect(isAutomated('GET', { 'user-agent': '' })).toBe(true);
  });

  it('nie uznaje zwykłej przeglądarki za automat', () => {
    expect(isAutomated('GET', { 'user-agent': CHROME_ANDROID })).toBe(false);
    expect(isAutomated('GET', { 'user-agent': SAFARI_IOS })).toBe(false);
  });

  it('nie uznaje telefonu z „bot” w nazwie modelu za automat', () => {
    const cubot = 'Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
    expect(isAutomated('get', { 'user-agent': cubot })).toBe(false);
  });

  it('odczytuje nagłówek podany jako tablica', () => {
    expect(isAutomated('GET', { 'user-agent': ['WhatsApp/2.23'] })).toBe(true);
    expect(isAutomated('GET', { 'user-agent': [CHROME_ANDROID] })).toBe(false);
  });
});
