/**
 * Token acquisition.
 *
 * VK stopped granting the `messages` scope to third-party apps years ago, so the
 * standard workaround (used by every VK export tool) is to log in through the
 * OAuth "implicit flow" using the client_id of an official/whitelisted client.
 * The resulting token is a normal user token that can read your own messages.
 * We never see your password: the login happens on vk.com itself, and you only
 * paste back the resulting URL.
 */

export const APPS = {
  // Kate Mobile: the classic choice, has messages + audio + video "files" access.
  kate: {
    id: 2685278,
    name: 'Kate Mobile',
    userAgent: 'KateMobileAndroid/109 lite-561 (Android 9; SDK 28; arm64-v8a; Xiaomi Redmi Note 8; ru)',
  },
  // Official VK for Android.
  android: {
    id: 2274003,
    name: 'VK Android',
    userAgent: 'VKAndroidApp/8.60-20321 (Android 12; SDK 31; arm64-v8a; Google Pixel 6; ru; 2400x1080)',
  },
  // Official VK for iPhone.
  iphone: {
    id: 3140623,
    name: 'VK iPhone',
    userAgent: 'com.vk.vkclient/1425 (iPhone, iOS 16.6, iPhone13,2, Scale/3.0)',
  },
  // VK Admin: sometimes works when the others are blocked.
  vkadmin: {
    id: 6121396,
    name: 'VK Admin',
    userAgent: 'VKAndroidApp/8.60-20321 (Android 12; SDK 31; arm64-v8a; Google Pixel 6; ru; 2400x1080)',
  },
};

export const SCOPE = ['messages', 'photos', 'video', 'docs', 'audio', 'wall', 'groups', 'friends', 'offline'];

export const REDIRECT_URI = 'https://oauth.vk.com/blank.html';

export function buildAuthUrl({ app = 'kate', appId, apiVersion = '5.131', revoke = true, domain = 'vk.com' } = {}) {
  const clientId = appId ?? APPS[app]?.id;
  if (!clientId) throw new Error(`Unknown app "${app}". Known: ${Object.keys(APPS).join(', ')} (or pass --app-id).`);
  const params = new URLSearchParams({
    client_id: String(clientId),
    scope: SCOPE.join(','),
    redirect_uri: `https://oauth.${domain}/blank.html`,
    display: 'page',
    response_type: 'token',
    v: apiVersion,
  });
  if (revoke) params.set('revoke', '1');
  return `https://oauth.${domain}/authorize?${params.toString()}`;
}

/**
 * Accepts the full URL the browser lands on after login
 * (https://oauth.vk.com/blank.html#access_token=...&expires_in=0&user_id=123),
 * a bare fragment, or a bare token; returns { access_token, user_id, expires_in }.
 */
export function parseTokenInput(input) {
  const s = String(input ?? '').trim();
  if (!s) throw new Error('Empty input');
  let fragment = s;
  if (s.includes('#')) fragment = s.slice(s.indexOf('#') + 1);
  else if (s.includes('?')) fragment = s.slice(s.indexOf('?') + 1);
  if (fragment.includes('access_token=')) {
    const p = new URLSearchParams(fragment);
    const token = p.get('access_token');
    if (!token) throw new Error('No access_token found in the pasted URL');
    // The host we actually landed on (oauth.vk.ru vs oauth.vk.com) tells us which
    // domain works from this network; the API client should start there.
    const host = /^https?:\/\/[^/]*?(vk\.(?:com|ru))(?:[/#?]|$)/i.exec(s);
    return {
      access_token: token,
      user_id: p.get('user_id') ? Number(p.get('user_id')) : undefined,
      expires_in: p.get('expires_in') ? Number(p.get('expires_in')) : undefined,
      domain: host ? host[1].toLowerCase() : undefined,
    };
  }
  if (fragment.includes('error=')) {
    const p = new URLSearchParams(fragment);
    throw new Error(`VK returned an error instead of a token: ${p.get('error')} (${p.get('error_description') ?? ''})`);
  }
  if (/^[a-zA-Z0-9._-]{40,}$/.test(s)) return { access_token: s };
  throw new Error(
    'Could not recognise a token in the input. Paste the whole URL from the address bar (it starts with https://oauth.vk.com/blank.html#access_token=... or https://oauth.vk.ru/blank.html#access_token=...).',
  );
}
