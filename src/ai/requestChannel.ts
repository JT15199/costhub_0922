export type RequestChannel = 'local' | 'cloud' | 'unknown';
// Legacy records used several spellings; missing provenance remains unknown.
export function requestChannel(row: { request_channel?: string; provider_name?: string }): RequestChannel {
  if (row.request_channel === 'local' || row.request_channel === 'cloud') return row.request_channel;
  const provider = (row.provider_name || '').trim().toLowerCase();
  if (/^(ollama|llama\.cpp)(?:$|[ （(])/.test(provider)) return 'local';
  return provider ? 'cloud' : 'unknown';
}
export const REQUEST_CHANNEL_SQL = `CASE
  WHEN request_channel IN ('local','cloud') THEN request_channel
  WHEN lower(trim(provider_name)) IN ('ollama','llama.cpp')
    OR lower(trim(provider_name)) LIKE 'ollama %' OR lower(trim(provider_name)) LIKE 'ollama（%'
    OR lower(trim(provider_name)) LIKE 'ollama(%' OR lower(trim(provider_name)) LIKE 'llama.cpp %'
    OR lower(trim(provider_name)) LIKE 'llama.cpp（%' OR lower(trim(provider_name)) LIKE 'llama.cpp(%' THEN 'local'
  WHEN trim(COALESCE(provider_name,'')) = '' THEN 'unknown'
  ELSE 'cloud' END`;
