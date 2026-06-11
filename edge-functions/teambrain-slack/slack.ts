// teambrain-slack/slack.ts — Slack wire-protocol helpers: request-signature
// verification, slash-command payload parsing, response_url delivery, and
// mrkdwn formatting. No TeamBrain logic lives here; index.ts owns that.
//
// Signature scheme (Slack "Verifying requests" docs, version v0):
//   basestring = "v0:" + X-Slack-Request-Timestamp + ":" + <raw body>
//   X-Slack-Signature = "v0=" + hex(HMAC-SHA256(signing_secret, basestring))
// The timestamp is bounded to ±5 minutes to cut replay windows, and the
// comparison is constant-time. The signing secret is the ONLY Slack
// credential this integration holds (slash-command-only app — no bot token,
// no Events API; replies go through the payload's response_url, which
// accepts unauthenticated POSTs for 30 minutes).

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

const SIGNATURE_VERSION   = 'v0';
const MAX_TIMESTAMP_SKEW  = 300; // seconds

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time string equality (both sides are short hex strings).
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifySlackSignature(
  signingSecret: string,
  rawBody:       string,
  timestamp:     string | undefined,
  signature:     string | undefined,
): Promise<boolean> {
  if (!timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > MAX_TIMESTAMP_SKEW) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${SIGNATURE_VERSION}:${timestamp}:${rawBody}`),
  );
  return timingSafeEqual(`${SIGNATURE_VERSION}=${hex(mac)}`, signature);
}

// ---------------------------------------------------------------------------
// Slash-command payload
// ---------------------------------------------------------------------------

// The application/x-www-form-urlencoded fields Slack POSTs for a slash
// command (the subset this integration reads).
export interface SlashPayload {
  teamId:      string;
  teamDomain:  string;
  channelId:   string;
  channelName: string;
  userId:      string;
  userName:    string;
  command:     string;   // e.g. "/tb"
  text:        string;   // everything after the command
  responseUrl: string;
}

export function parseSlashPayload(rawBody: string): SlashPayload {
  const p = new URLSearchParams(rawBody);
  const get = (k: string) => p.get(k) ?? '';
  return {
    teamId:      get('team_id'),
    teamDomain:  get('team_domain'),
    channelId:   get('channel_id'),
    channelName: get('channel_name'),
    userId:      get('user_id'),
    userName:    get('user_name'),
    command:     get('command'),
    text:        get('text').trim(),
    responseUrl: get('response_url'),
  };
}

// Split "remember some text here" → { sub: "remember", rest: "some text here" }.
export function splitSubcommand(text: string): { sub: string; rest: string } {
  const m = text.match(/^(\S+)\s*([\s\S]*)$/);
  if (!m) return { sub: '', rest: '' };
  return { sub: m[1].toLowerCase(), rest: m[2].trim() };
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

// `ephemeral` is visible only to the invoking user; `in_channel` posts for
// everyone (and echoes the original command invocation above it).
export type SlackVisibility = 'ephemeral' | 'in_channel';

export interface SlackMessage {
  response_type: SlackVisibility;
  text:          string;
}

export function slackMessage(visibility: SlackVisibility, text: string): SlackMessage {
  return { response_type: visibility, text };
}

// Deliver a delayed response through the slash payload's response_url
// (valid for 30 min, up to 5 messages). Failures are logged, not thrown —
// by the time this runs we have already ACKed Slack, so there is no caller
// to surface an error to.
export async function postToResponseUrl(responseUrl: string, message: SlackMessage): Promise<void> {
  try {
    const res = await fetch(responseUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(message),
    });
    if (!res.ok) {
      console.error(`teambrain-slack: response_url POST failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error('teambrain-slack: response_url POST threw:', err);
  }
}

// ---------------------------------------------------------------------------
// mrkdwn formatting
// ---------------------------------------------------------------------------

// Slack mrkdwn requires only &, <, > escaped (its control characters).
export function mrkdwnEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

// "3d ago" — coarse relative age for recent/recall listings.
export function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60)   return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48)     return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60)      return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
